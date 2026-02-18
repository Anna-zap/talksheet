import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { Entry, SessionStatus } from './types.ts';
import { createPcmBlob, decode, decodeAudioData } from './utils/audioUtils.ts';

const SILENCE_THRESHOLD_MS = 3000;
const STORAGE_KEY = 'talksheet_entries';
const TRIAL_KEY = 'talksheet_trial_start';
const PRO_KEY = 'talksheet_is_pro';
const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-12-2025';
const TRIAL_DAYS = 7;

const TalkSheetBadge = ({ size = "large" }: { size?: "large" | "small" }) => {
  const dimensions = size === "large" ? "w-28 h-28" : "w-10 h-10";
  const fontSize = size === "large" ? "text-[14px]" : "text-[6px]";
  const rounded = size === "large" ? "rounded-3xl" : "rounded-lg";
  
  return (
    <div className={`${dimensions} ${rounded} bg-zinc-900 flex flex-col items-center justify-center shadow-xl`}>
      <span className={`${fontSize} text-white font-bold tracking-[0.25em] leading-tight uppercase`}>Talk</span>
      <span className={`${fontSize} text-white font-extralight tracking-[0.25em] leading-tight uppercase`}>Sheet</span>
    </div>
  );
};

export default function App() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [currentText, setCurrentText] = useState('');
  const [status, setStatus] = useState<SessionStatus>(SessionStatus.IDLE);
  const [isConfirmingClear, setIsConfirmingClear] = useState(false);
  const [showSavedToast, setShowSavedToast] = useState(false);
  const [showSubscription, setShowSubscription] = useState(false);
  const [isUpgrading, setIsUpgrading] = useState(false);
  const [isPro, setIsPro] = useState(false);
  const [trialDaysLeft, setTrialDaysLeft] = useState<number | null>(null);
  
  const statusRef = useRef<SessionStatus>(SessionStatus.IDLE);
  const currentTextRef = useRef('');
  const audioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef<any>(null);
  const silenceTimerRef = useRef<any>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const wakeLockRef = useRef<any>(null);

  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => { currentTextRef.current = currentText; }, [currentText]);

  useEffect(() => {
    const paid = localStorage.getItem(PRO_KEY) === 'true';
    setIsPro(paid);

    let trialStart = localStorage.getItem(TRIAL_KEY);
    if (!trialStart) {
      trialStart = Date.now().toString();
      localStorage.setItem(TRIAL_KEY, trialStart);
    }
    const daysPassed = Math.floor((Date.now() - parseInt(trialStart)) / (1000 * 60 * 60 * 24));
    setTrialDaysLeft(Math.max(0, TRIAL_DAYS - daysPassed));

    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try { setEntries(JSON.parse(saved)); } catch (e) { console.error(e); }
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  }, [entries]);

  useEffect(() => {
    if (scrollAreaRef.current) {
      scrollAreaRef.current.scrollTop = scrollAreaRef.current.scrollHeight;
    }
  }, [entries, currentText]);

  const finalizeEntry = useCallback(() => {
    const text = currentTextRef.current.trim();
    if (text) {
      const newEntry: Entry = {
        id: crypto.randomUUID(),
        text: text,
        timestamp: Date.now(),
      };
      setEntries(prev => [...prev, newEntry]);
      setCurrentText('');
      currentTextRef.current = '';
      if ('vibrate' in navigator) navigator.vibrate(50);
      setShowSavedToast(true);
      setTimeout(() => setShowSavedToast(false), 2000);
    }
  }, []);

  const stopSession = useCallback(async () => {
    if (sessionRef.current) {
      try { sessionRef.current.close(); } catch(e) {}
      sessionRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (audioContextRef.current) {
      try { await audioContextRef.current.close(); } catch(e) {}
      audioContextRef.current = null;
    }
    if (outputAudioContextRef.current) {
      try { await outputAudioContextRef.current.close(); } catch(e) {}
      outputAudioContextRef.current = null;
    }
    sourcesRef.current.forEach(source => { try { source.stop(); } catch(e) {} });
    sourcesRef.current.clear();
    nextStartTimeRef.current = 0;
    
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    if (wakeLockRef.current) {
      try { await wakeLockRef.current.release(); wakeLockRef.current = null; } catch (err) {}
    }

    setStatus(SessionStatus.IDLE);
  }, []);

  const startSession = useCallback(async () => {
    if (statusRef.current === SessionStatus.LISTENING || statusRef.current === SessionStatus.CONNECTING) return;
    
    if (!isPro && trialDaysLeft === 0) {
      setShowSubscription(true);
      return;
    }

    try {
      setStatus(SessionStatus.CONNECTING);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      audioContextRef.current = inputCtx;
      outputAudioContextRef.current = outputCtx;

      const muteNode = outputCtx.createGain();
      muteNode.gain.value = 0;
      muteNode.connect(outputCtx.destination);

      const sessionPromise = ai.live.connect({
        model: MODEL_NAME,
        callbacks: {
          onopen: () => {
            setStatus(SessionStatus.LISTENING);
            if ('vibrate' in navigator) navigator.vibrate(20);
            if ('wakeLock' in navigator) {
              (navigator as any).wakeLock.request('screen').then((lock: any) => wakeLockRef.current = lock).catch(() => {});
            }
            
            const source = inputCtx.createMediaStreamSource(stream);
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createPcmBlob(inputData);
              sessionPromise.then(session => session.sendRealtimeInput({ media: pcmBlob })).catch(() => {});
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.serverContent?.inputTranscription) {
              const text = message.serverContent.inputTranscription.text;
              if (text) {
                setCurrentText(prev => prev + text);
                if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
                silenceTimerRef.current = setTimeout(() => { finalizeEntry(); stopSession(); }, SILENCE_THRESHOLD_MS);
              }
            }
            const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio && outputAudioContextRef.current) {
              const outCtx = outputAudioContextRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outCtx.currentTime);
              const audioBuffer = await decodeAudioData(decode(base64Audio), outCtx, 24000, 1);
              const source = outCtx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(muteNode); 
              source.addEventListener('ended', () => sourcesRef.current.delete(source));
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sourcesRef.current.add(source);
            }
          },
          onerror: () => { setStatus(SessionStatus.ERROR); stopSession(); },
          onclose: () => { setStatus(SessionStatus.IDLE); }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {}, 
          systemInstruction: "Transcribe user speech accurately and concisely. Only provide the text of what the user says. Do not respond to them."
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err: any) {
      setStatus(err.name === 'NotAllowedError' ? SessionStatus.PERMISSION_DENIED : SessionStatus.ERROR);
      stopSession();
    }
  }, [finalizeEntry, stopSession, trialDaysLeft, isPro]);

  const handleCopyAll = () => {
    const fullText = entries.map(e => e.text).join('\n\n');
    navigator.clipboard.writeText(fullText);
    if ('vibrate' in navigator) navigator.vibrate([10, 30, 10]);
    setShowSavedToast(true);
    setTimeout(() => setShowSavedToast(false), 2000);
  };

  const handleShare = async () => {
    const fullText = entries.map(e => e.text).join('\n\n');
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'My TalkSheet',
          text: fullText,
        });
      } catch (err) {}
    } else {
      handleCopyAll();
    }
  };

  const handleCopyEntry = (text: string) => {
    navigator.clipboard.writeText(text);
    if ('vibrate' in navigator) navigator.vibrate(10);
  };

  const clearAll = () => {
    if (!isConfirmingClear) { 
      setIsConfirmingClear(true); 
      setTimeout(() => setIsConfirmingClear(false), 3000); 
      return; 
    }
    setEntries([]);
    setCurrentText('');
    localStorage.removeItem(STORAGE_KEY);
    setIsConfirmingClear(false);
    if ('vibrate' in navigator) navigator.vibrate(100);
  };

  const handleUpgrade = () => {
    setIsUpgrading(true);
    setTimeout(() => {
      setIsPro(true);
      localStorage.setItem(PRO_KEY, 'true');
      setIsUpgrading(false);
      setShowSubscription(false);
    }, 2000);
  };

  const hasContent = entries.length > 0 || currentText.length > 0;
  const isBusy = status === SessionStatus.LISTENING || status === SessionStatus.CONNECTING;

  return (
    <div className="flex flex-col h-screen w-full bg-[#fafafa]">
      {!hasContent && !isBusy ? (
        <div className="flex-grow flex flex-col items-center justify-center p-8 text-center safe-top animate-in fade-in zoom-in duration-500">
          <div className="mb-12"><TalkSheetBadge /></div>
          <h2 className="text-xl font-medium text-zinc-900 mb-2">Ready to Listen</h2>
          <div className="mb-16">
            <p className="text-[10px] text-zinc-400 mb-1 uppercase tracking-[0.3em]">Instant Voice Recording</p>
            <p className="text-[13px] text-zinc-500 font-light italic">"You talk, I write"</p>
          </div>
          <button 
            onClick={startSession} 
            className="w-24 h-24 rounded-full bg-zinc-900 flex items-center justify-center text-white shadow-[0_20px_50px_rgba(0,0,0,0.2)] active:scale-90 transition-all hover:scale-105"
            aria-label="Start Listening"
          >
             <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
               <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
             </svg>
          </button>
          
          <button 
            onClick={() => setShowSubscription(true)}
            className="mt-12 text-[9px] uppercase tracking-widest text-zinc-400 hover:text-zinc-600 transition-colors flex items-center gap-2"
          >
            {isPro ? (
              <span className="flex items-center gap-1"><div className="w-1 h-1 rounded-full bg-emerald-500" /> Pro Account</span>
            ) : (
              <span>Trial: {trialDaysLeft} days left</span>
            )}
          </button>
        </div>
      ) : (
        <div className="flex flex-col h-full safe-top">
          <header className="flex justify-between items-center px-6 py-4 border-b border-zinc-100 bg-white/80 backdrop-blur-md sticky top-0 z-50">
            <div className="flex items-center gap-3">
              <TalkSheetBadge size="small" />
              <h1 className="text-sm font-bold text-zinc-900 tracking-tight">TalkSheet</h1>
            </div>
            <div className="flex items-center gap-3">
              <StatusIndicator status={status} onRetry={startSession} />
              <button 
                onClick={clearAll} 
                className={`text-[9px] font-black px-3 py-1.5 rounded-full uppercase tracking-widest transition-all ${isConfirmingClear ? 'bg-red-50 text-red-500 ring-1 ring-red-100' : 'text-zinc-300'}`}
              >
                {isConfirmingClear ? 'Confirm?' : 'Clear'}
              </button>
            </div>
          </header>

          <main ref={scrollAreaRef} className="flex-grow overflow-y-auto px-6 py-12 space-y-16 touch-pan-y pb-40" style={{ WebkitOverflowScrolling: 'touch' }}>
            {entries.map((entry) => (
              <article key={entry.id} className="group relative border-l border-zinc-100 pl-5 -ml-5 animate-entry">
                <p className="text-[1.15rem] leading-[1.6] text-zinc-800 break-words whitespace-pre-wrap font-normal selection:bg-zinc-900 selection:text-white">{entry.text}</p>
                <div className="mt-4 flex items-center gap-6 opacity-30 group-hover:opacity-100 transition-opacity">
                  <span className="text-[8px] text-zinc-400 tabular-nums uppercase tracking-tighter">
                    {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <button onClick={() => handleCopyEntry(entry.text)} className="text-[9px] uppercase tracking-[0.15em] text-zinc-500 font-bold active:text-zinc-900">Copy</button>
                </div>
              </article>
            ))}

            {currentText && (
              <div className="relative border-l-2 border-zinc-900 pl-5 -ml-5">
                <p className="text-2xl font-light leading-snug text-zinc-900 break-words whitespace-pre-wrap">
                  {currentText}
                  <span className="inline-block w-[2px] h-7 ml-1 bg-red-500 animate-pulse align-middle"></span>
                </p>
              </div>
            )}
          </main>

          {/* Floating Action Buttons */}
          <div className="fixed bottom-32 right-6 flex flex-col gap-4 z-50 pointer-events-none">
             {entries.length > 0 && (
               <>
                <button 
                  onClick={handleShare}
                  className="w-14 h-14 rounded-full bg-white border border-zinc-200 shadow-[0_10px_30px_rgba(0,0,0,0.1)] flex items-center justify-center text-zinc-600 active:scale-90 transition-all pointer-events-auto hover:bg-zinc-50"
                  aria-label="Share Sheet"
                >
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" /></svg>
                </button>
                <button 
                  onClick={handleCopyAll}
                  className="w-14 h-14 rounded-full bg-white border border-zinc-200 shadow-[0_10px_30px_rgba(0,0,0,0.1)] flex items-center justify-center text-zinc-600 active:scale-90 transition-all pointer-events-auto hover:bg-zinc-50"
                  aria-label="Copy All"
                >
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" /></svg>
                </button>
               </>
             )}
          </div>

          <footer className="fixed bottom-0 left-0 right-0 px-10 pb-[calc(2rem+var(--sab))] pt-8 bg-gradient-to-t from-[#fafafa] via-[#fafafa] to-transparent pointer-events-none z-40">
            <div className="max-w-2xl mx-auto flex justify-center pointer-events-auto">
              <button 
                onClick={status === SessionStatus.LISTENING ? () => { finalizeEntry(); stopSession(); } : startSession}
                disabled={status === SessionStatus.CONNECTING}
                className={`min-w-[200px] h-16 rounded-full text-[11px] font-black tracking-[0.25em] uppercase shadow-2xl active:scale-95 transition-all flex items-center justify-center gap-4 ${status === SessionStatus.LISTENING ? 'bg-white border border-zinc-200 text-zinc-900 ring-4 ring-zinc-900/5' : 'bg-zinc-900 text-white'}`}
              >
                {status === SessionStatus.LISTENING ? (
                  <><div className="w-3 h-3 rounded-full bg-red-500 animate-pulse" /> Stop Listening</>
                ) : status === SessionStatus.CONNECTING ? (
                  <div className="flex items-center gap-2"><div className="w-4 h-4 border-2 border-zinc-400 border-t-white rounded-full animate-spin" /> Syncing</div>
                ) : 'Capture Thought'}
              </button>
            </div>
          </footer>
        </div>
      )}

      {showSubscription && (
        <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center p-4">
          <div className="absolute inset-0 bg-zinc-900/60 backdrop-blur-sm" onClick={() => !isUpgrading && setShowSubscription(false)} />
          <div className="relative w-full max-w-md bg-white rounded-[2.5rem] p-10 shadow-2xl animate-in slide-in-from-bottom-10 duration-500 overflow-hidden">
            {!isUpgrading && (
              <button onClick={() => setShowSubscription(false)} className="absolute top-6 right-6 text-zinc-400 hover:text-zinc-600">
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            )}
            
            <div className="mb-8"><TalkSheetBadge size="small" /></div>
            
            {isPro ? (
              <div className="text-center py-4">
                <div className="w-20 h-20 bg-emerald-50 rounded-full flex items-center justify-center text-emerald-500 mx-auto mb-6">
                  <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
                </div>
                <h3 className="text-2xl font-bold text-zinc-900 mb-2">TalkSheet Pro Active</h3>
                <p className="text-zinc-500 text-sm mb-8">Thank you for supporting minimalist software.</p>
                <button onClick={() => setShowSubscription(false)} className="w-full h-14 border border-zinc-200 text-zinc-900 rounded-2xl font-bold text-sm tracking-wide active:bg-zinc-50">Close</button>
              </div>
            ) : (
              <>
                <h3 className="text-2xl font-bold text-zinc-900 mb-2">TalkSheet Pro</h3>
                <p className="text-zinc-500 text-sm mb-8 leading-relaxed">
                  Unlimited voice sheets, instant transcription, and zero distraction. Join <strong>TalkSheet Pro</strong> for early access.
                </p>
                
                <div className="bg-zinc-50 rounded-2xl p-6 border border-zinc-100 mb-8">
                  <div className="flex justify-between items-center">
                    <div>
                      <span className="block text-[10px] uppercase tracking-widest text-zinc-400 font-bold mb-1">Annual Plan</span>
                      <span className="text-3xl font-black text-zinc-900">€10<span className="text-sm font-normal text-zinc-400">/year</span></span>
                    </div>
                    <div className="bg-zinc-900 text-white text-[9px] px-3 py-1.5 rounded-full uppercase tracking-tighter font-bold">Best Value</div>
                  </div>
                </div>

                <button 
                  onClick={handleUpgrade}
                  disabled={isUpgrading}
                  className={`w-full h-14 rounded-2xl font-bold text-sm tracking-wide active:scale-95 transition-all mb-4 flex items-center justify-center ${isUpgrading ? 'bg-zinc-100 text-zinc-400 cursor-not-allowed' : 'bg-zinc-900 text-white shadow-xl shadow-zinc-900/20'}`}
                >
                  {isUpgrading ? (
                    <div className="flex items-center gap-3">
                      <div className="w-4 h-4 border-2 border-zinc-300 border-t-zinc-800 rounded-full animate-spin" />
                      Processing...
                    </div>
                  ) : 'Upgrade Now'}
                </button>
                <p className="text-center text-[10px] text-zinc-400 uppercase tracking-widest">7-Day Free Trial Included</p>
              </>
            )}
          </div>
        </div>
      )}
      
      {showSavedToast && (
        <div className="fixed top-24 left-1/2 -translate-x-1/2 z-[60] animate-in fade-in slide-in-from-top-4 duration-300 pointer-events-none">
          <div className="bg-zinc-800 text-white text-[9px] px-6 py-2.5 rounded-full uppercase tracking-widest font-bold shadow-2xl">Sheet Updated</div>
        </div>
      )}
    </div>
  );
}

function StatusIndicator({ status, onRetry }: { status: SessionStatus, onRetry: () => void }) {
  if (status === SessionStatus.LISTENING) return <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-red-50"><div className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" /><span className="text-[9px] font-black text-red-600 uppercase tracking-widest">Live</span></div>;
  if (status === SessionStatus.CONNECTING) return <span className="text-[9px] text-zinc-400 uppercase tracking-widest animate-pulse font-bold px-3">Syncing...</span>;
  if (status === SessionStatus.ERROR) return <button onClick={onRetry} className="text-[9px] font-bold text-red-500 uppercase tracking-widest bg-red-50 px-3 py-1 rounded-full border border-red-100">Retry</button>;
  return <span className="text-[9px] text-zinc-300 uppercase tracking-widest font-bold px-3">Standby</span>;
}
