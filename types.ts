export interface Entry {
  id: string;
  text: string;
  timestamp: number;
}

export enum SessionStatus {
  IDLE = 'IDLE',
  CONNECTING = 'CONNECTING',
  LISTENING = 'LISTENING',
  ERROR = 'ERROR',
  PERMISSION_DENIED = 'PERMISSION_DENIED'
}
