export type Category = 'object' | 'scenery' | 'portrait';
export interface FocusCrop { x: number; y: number; zoom: number }
export interface PanelCrop { x: number; y: number; width: number; height: number }
export interface Panel {
  blob: Blob; width: number; height: number; sha256: string;
  provider: string; model: string; generatedAt: string; requestId: string;
}
export interface MagnetWork {
  id: string; revision: number; createdAt: string; updatedAt: string; journeyId?: string;
  originalPhoto: Blob; sourcePhoto: Blob; sourceWidth: number; sourceHeight: number;
  category: Category; subjectDescription: string; title: string; place: string; year: string;
  backgroundColor: string; style: 'enamel'; photoCrop: FocusCrop; panelCrop: PanelCrop;
  task?: { id: string; state: 'GENERATING' | 'READY' | 'FAILED' | 'UNKNOWN'; error?: string; startedAt: string };
  panel?: Panel;
  poster?: { blob: Blob; width: number; height: number; createdAt: string; revision: number };
}
export function newWork(photo: { blob: Blob; width: number; height: number }, originalPhoto: Blob, journeyId?: string): MagnetWork {
  const now = new Date().toISOString();
  return { id: newId(), revision: 0, createdAt: now, updatedAt: now, journeyId,
    originalPhoto, sourcePhoto: photo.blob, sourceWidth: photo.width, sourceHeight: photo.height,
    category: 'scenery', subjectDescription: '', title: '', place: '', year: '', backgroundColor: '#e8e0d4',
    style: 'enamel', photoCrop: { x: .5, y: .5, zoom: 1 }, panelCrop: { x: 0, y: 0, width: 1, height: 1 } };
}
import { newId } from '../../domain/id.ts';
