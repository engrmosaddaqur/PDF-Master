export type AppLanguage = 'en' | 'bn';
export type ThemeMode = 'light' | 'dark' | 'auto';
export type NavTab = 'home' | 'files' | 'tools' | 'create' | 'settings';

export type DocumentCategory =
  | 'recent'
  | 'my'
  | 'scanned'
  | 'created'
  | 'edited'
  | 'starred'
  | 'shared'
  | 'trash';

export type PaperSizeKey =
  | 'A0'
  | 'A1'
  | 'A2'
  | 'A3'
  | 'A4'
  | 'A5'
  | 'A6'
  | 'Letter'
  | 'Legal'
  | 'Executive'
  | 'Custom';

export interface PaperDimension {
  key: PaperSizeKey;
  label: string;
  widthPt: number;
  heightPt: number;
  widthMm: number;
  heightMm: number;
}

export interface WordPageSettings {
  paperSize: PaperSizeKey;
  orientation: 'portrait' | 'landscape';
  customWidthMm: number;
  customHeightMm: number;
  marginTopMm: number;
  marginBottomMm: number;
  marginLeftMm: number;
  marginRightMm: number;
  backgroundColor: string;
  borderEnabled: boolean;
  borderColor: string;
  headerText: string;
  footerText: string;
  pageNumbering: boolean;
}

export interface DocumentVersion {
  id: string;
  timestamp: number;
  note: string;
  sizeBytes: number;
  pdfBytes: ArrayBuffer;
}

export interface DocumentRecord {
  id: string;
  name: string;
  origin: 'imported' | 'scanned' | 'created' | 'edited' | 'converted';
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
  sizeBytes: number;
  pageCount: number;
  isStarred: boolean;
  isShared: boolean;
  isTrashed: boolean;
  folderId: string | null;
  thumbnailDataUrl?: string;
  pdfBytes: ArrayBuffer;
  editableHtml?: string;
  wordSettings?: WordPageSettings;
  bookmarks?: number[];
  versions: DocumentVersion[];
  sha256Seal?: string;
  isVaultLocked?: boolean;
  vaultSalt?: string;
  vaultIv?: string;
}

export interface FolderRecord {
  id: string;
  name: string;
  createdAt: number;
  color: string;
}

export interface SavedSignature {
  id: string;
  label: string;
  dataUrl: string;
  type: 'drawn' | 'image';
  createdAt: number;
}

export interface AppSettings {
  language: AppLanguage;
  theme: ThemeMode;
  defaultViewMode: 'continuous' | 'single';
  defaultPageSize: PaperSizeKey;
  defaultFont: string;
  scannerAutoCrop: boolean;
  scannerDefaultFilter: 'color' | 'magic' | 'grayscale' | 'bw';
  exportQuality: 'standard' | 'high' | 'maximum';
  aiConsentGranted: boolean;
  localOnlyMode: boolean;
}

export interface ExtractedTextRun {
  id: string;
  pageNumber: number;
  str: string;
  /** PDF coordinate normalized to unrotated top-left viewport at scale 1 */
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  fontName: string;
}

export interface TextReplacementEdit {
  id: string;
  runId: string;
  pageNumber: number;
  originalText: string;
  newText: string;
  deleted: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  fontFamily: 'sans' | 'serif' | 'mono';
  color: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  align: 'left' | 'center' | 'right';
  letterSpacing: number;
}

export interface AddedTextBox {
  id: string;
  pageNumber: number;
  text: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
  fontFamily: 'sans' | 'serif' | 'mono';
  color: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  align: 'left' | 'center' | 'right';
  letterSpacing: number;
}

export interface AddedImageOverlay {
  id: string;
  pageNumber: number;
  dataUrl: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}

export interface AnnotationOverlay {
  id: string;
  pageNumber: number;
  kind:
    | 'highlight'
    | 'underline'
    | 'strikethrough'
    | 'freehand'
    | 'rect'
    | 'circle'
    | 'arrow'
    | 'sticky'
    | 'signature'
    | 'stamp';
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  strokeWidth?: number;
  points?: Array<{ x: number; y: number }>;
  comment?: string;
  stickyArrow?: 'left' | 'right' | 'top' | 'bottom';
  author?: string;
  dateStr?: string;
  signatureDataUrl?: string;
  signerName?: string;
}

export type ActiveWorkspace =
  | { type: 'none' }
  | { type: 'viewer'; docId: string; initialPage?: number }
  | { type: 'editor'; docId: string }
  | { type: 'organizer'; docId: string }
  | { type: 'scanner' }
  | { type: 'ocr'; docId?: string; initialImage?: string }
  | { type: 'wordCreator'; docId?: string }
  | { type: 'compare'; docIdA?: string; docIdB?: string }
  | { type: 'aiAssistant'; docId?: string }
  | { type: 'toolRunner'; toolId: string; preselectedDocId?: string };
