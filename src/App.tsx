import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { motion, AnimatePresence } from 'motion/react';
import { Mic, StopCircle, Trash2, Copy, CheckCircle2, AlertCircle, RefreshCw } from 'lucide-react';
import { Entry, SessionStatus } from './types';
import { createPcmBlob, decode, decodeAudioData } from './utils/audioUtils';

const SILENCE_THRESHOLD_MS = 3000;
const STORAGE_KEY = 'talksheet_entries';
const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-12-2025';

const TalkSheetBadge = ({ size = "large" }: { size?: "large" | "small" }) => {
  const dimensions = size === "large" ? "w-32 h-32" : "w-10 h-10";
  const fontSize = size === "large" ? "text-[16px]" : "text-[6px]";
  const rounded = size === "large" ? "rounded-[2.5rem]" : "rounded-lg";
  
  return (
    <div className={`${dimensions} ${rounded} bg-zinc-900 flex flex-col items-center justify-center shadow-2xl transition-transform active:scale-95`}>
      <span className={`${fontSize} text-white font-bold tracking-[0.3em] leading-tight uppercase`}>Talk</span>
      <span className={`${fontSize} text-white font-extralight tracking-[0.3em] leading-tight uppercase`}>Sheet</span>
    </div>
  );
};

export default function App() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [currentText, setCurrentText] = useState('');
  const [status, setStatus] = useState<SessionStatus>(SessionStatus.IDLE);
  const [isConfirmingClear, setIsConfirmingClear] = useState(false);
  const [showSavedToast, setShowSavedToast] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  
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

  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => { currentTextRef.current = currentText; }, [currentText]);

  useEffect(() => {
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
      scrollAreaRef.current.scrollTo({
        top: scrollAreaRef.current.scrollHeight,
        behavior: 'smooth'
      });
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
      if ('vibrate' in navigator) navigator.vibrate([10, 50]);
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
    setStatus(SessionStatus.IDLE);
  }, []);

  const startSession = useCallback(async () => {
    if (statusRef.current === SessionStatus.LISTENING || statusRef.current === SessionStatus.CONNECTING) return;
    
    try {
      setStatus(SessionStatus.CONNECTING);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      
      const apiKey = process.env.API_KEY;
      if (!apiKey) {
        throw new Error("API Key not found. Please set API_KEY in your environment.");
      }

      const ai = new GoogleGenAI({ apiKey });
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
            if ('vibrate' in navigator) navigator.vibrate(30);
            
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
      console.error("Session failed:", err);
      setStatus(err.name === 'NotAllowedError' ? SessionStatus.PERMISSION_DENIED : SessionStatus.ERROR);
      stopSession();
    }
  }, [finalizeEntry, stopSession]);

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

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const hasContent = entries.length > 0 || currentText.length > 0;
  const isBusy = status === SessionStatus.LISTENING || status === SessionStatus.CONNECTING;

  return (
    <div className="flex flex-col h-screen w-full bg-[#fafafa] font-sans">
      <AnimatePresence>
        {!hasContent && !isBusy ? (
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.05 }}
            className="flex-grow flex flex-col items-center justify-center p-8 text-center safe-top"
          >
            <div className="mb-14"><TalkSheetBadge /></div>
            <h2 className="text-2xl font-semibold text-zinc-900 mb-2 tracking-tight">Ready to Listen</h2>
            <div className="mb-20">
              <p className="text-[11px] text-zinc-400 mb-3 uppercase tracking-[0.4em] font-black">Instant Capture</p>
              <p className="text-[18px] text-zinc-500 font-extralight italic opacity-60">"You talk, I write"</p>
            </div>
            <motion.button 
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.9 }}
              onClick={startSession} 
              className="w-28 h-28 rounded-full bg-zinc-900 flex items-center justify-center text-white shadow-[0_30px_70px_-10px_rgba(0,0,0,0.35)] transition-all animate-breathe"
              aria-label="Start Listening"
            >
               <Mic className="w-10 h-10 stroke-[1.5]" />
            </motion.button>
          </motion.div>
        ) : (
          <div className="flex flex-col h-full safe-top">
            <header className="flex justify-between items-center px-6 py-5 border-b border-zinc-100 bg-white/90 backdrop-blur-xl sticky top-0 z-50">
              <div className="flex items-center gap-3">
                <TalkSheetBadge size="small" />
                <h1 className="text-sm font-black text-zinc-900 tracking-widest uppercase">TalkSheet</h1>
              </div>
              <div className="flex items-center gap-3">
                <StatusIndicator status={status} onRetry={startSession} />
                <button 
                  onClick={clearAll} 
                  className={`text-[10px] font-black px-4 py-2 rounded-full uppercase tracking-[0.2em] transition-all flex items-center gap-2 ${isConfirmingClear ? 'bg-red-50 text-red-600 ring-1 ring-red-100' : 'text-zinc-300 hover:text-zinc-500'}`}
                >
                  {isConfirmingClear ? <><AlertCircle size={10} /> Confirm?</> : <><Trash2 size={10} /> Clear</>}
                </button>
              </div>
            </header>

            <main ref={scrollAreaRef} className="flex-grow overflow-y-auto px-8 py-14 space-y-20 touch-pan-y pb-48 scroll-smooth" style={{ WebkitOverflowScrolling: 'touch' }}>
              <AnimatePresence initial={false}>
                {entries.length === 0 && !currentText && (
                   <motion.div 
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 0.2 }}
                    className="text-center py-24"
                   >
                     <p className="text-[11px] uppercase tracking-[0.5em] font-black">Waiting for thoughts</p>
                     <p className="text-[14px] italic mt-4">"You talk, I write"</p>
                   </motion.div>
                )}
                {entries.map((entry) => (
                  <motion.article 
                    layout
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    key={entry.id} 
                    className="group relative border-l-2 border-zinc-100 pl-8 -ml-8"
                  >
                    <p className="text-[1.25rem] leading-[1.8] text-zinc-800 break-words whitespace-pre-wrap font-normal selection:bg-zinc-900 selection:text-white">{entry.text}</p>
                    <div className="mt-6 flex items-center gap-8 opacity-0 group-hover:opacity-100 transition-all">
                      <span className="text-[9px] text-zinc-400 tabular-nums uppercase tracking-[0.3em] font-bold">
                        {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <button 
                        onClick={() => copyToClipboard(entry.text, entry.id)} 
                        className="flex items-center gap-2 text-[10px] uppercase tracking-[0.3em] text-zinc-400 font-black hover:text-zinc-900 active:scale-95 transition-all"
                      >
                        {copiedId === entry.id ? <><CheckCircle2 size={10} /> Copied</> : <><Copy size={10} /> Copy</>}
                      </button>
                    </div>
                  </motion.article>
                ))}
              </AnimatePresence>

              {currentText && (
                <motion.div 
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="relative border-l-4 border-zinc-900 pl-8 -ml-8"
                >
                  <p className="text-3xl font-extralight leading-relaxed text-zinc-900 break-words whitespace-pre-wrap opacity-90">
                    {currentText}
                    <span className="inline-block w-[3px] h-9 ml-3 bg-red-500 animate-pulse align-middle"></span>
                  </p>
                </motion.div>
              )}
            </main>

            <footer className="fixed bottom-0 left-0 right-0 px-10 pb-[calc(2.5rem+var(--sab))] pt-12 bg-gradient-to-t from-[#fafafa] via-[#fafafa] to-transparent pointer-events-none z-40">
              <div className="max-w-2xl mx-auto flex justify-center pointer-events-auto">
                <motion.button 
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={status === SessionStatus.LISTENING ? () => { finalizeEntry(); stopSession(); } : startSession}
                  disabled={status === SessionStatus.CONNECTING}
                  className={`min-w-[240px] h-18 py-5 rounded-full text-[12px] font-black tracking-[0.3em] uppercase shadow-[0_25px_60px_-12px_rgba(0,0,0,0.3)] transition-all flex items-center justify-center gap-5 ${status === SessionStatus.LISTENING ? 'bg-white border-2 border-zinc-900 text-zinc-900 ring-8 ring-zinc-900/5' : 'bg-zinc-900 text-white hover:bg-black'}`}
                >
                  {status === SessionStatus.LISTENING ? (
                    <><StopCircle className="w-5 h-5 text-red-500 animate-pulse" /> Stop Capture</>
                  ) : status === SessionStatus.CONNECTING ? (
                    <><RefreshCw className="w-5 h-5 animate-spin text-zinc-400" /> Syncing</>
                  ) : <><Mic className="w-5 h-5" /> Capture Thought</>}
                </motion.button>
              </div>
            </footer>
          </div>
        )}
      </AnimatePresence>
      
      <AnimatePresence>
        {showSavedToast && (
          <motion.div 
            initial={{ opacity: 0, y: -20, x: '-50%' }}
            animate={{ opacity: 1, y: 0, x: '-50%' }}
            exit={{ opacity: 0, y: -20, x: '-50%' }}
            className="fixed top-28 left-1/2 z-[60] pointer-events-none"
          >
            <div className="bg-zinc-900 text-white text-[10px] px-8 py-3 rounded-full uppercase tracking-[0.3em] font-black shadow-[0_20px_40px_rgba(0,0,0,0.4)] flex items-center gap-2">
              <CheckCircle2 size={12} className="text-emerald-400" /> Entry Saved
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function StatusIndicator({ status, onRetry }: { status: SessionStatus, onRetry: () => void }) {
  if (status === SessionStatus.LISTENING) return <div className="flex items-center gap-2.5 px-4 py-2 rounded-full bg-red-50 border border-red-100 shadow-sm"><div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" /><span className="text-[10px] font-black text-red-600 uppercase tracking-widest">Live</span></div>;
  if (status === SessionStatus.CONNECTING) return <span className="text-[10px] text-zinc-400 uppercase tracking-[0.2em] animate-pulse font-black px-4">Syncing...</span>;
  if (status === SessionStatus.ERROR) return <button onClick={onRetry} className="flex items-center gap-2 text-[10px] font-black text-red-500 uppercase tracking-widest bg-red-50 px-4 py-2 rounded-full border border-red-100 active:scale-95 transition-transform"><RefreshCw size={10} /> Retry</button>;
  if (status === SessionStatus.PERMISSION_DENIED) return <div className="flex items-center gap-2 text-[10px] font-black text-amber-600 uppercase tracking-widest bg-amber-50 px-4 py-2 rounded-full border border-amber-100"><AlertCircle size={10} /> Mic Blocked</div>;
  return <span className="text-[10px] text-zinc-300 uppercase tracking-[0.2em] font-black px-4">Standby</span>;
}