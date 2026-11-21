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
  editorState?: PdfEditorState;
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
  /** Original unbaked PDF bytes preserved when non-destructive editor overlays exist */
  basePdfBytes?: ArrayBuffer;
  /** Persistent non-destructive Edit PDF layers so previously added items remain editable across sessions */
  editorState?: PdfEditorState;
  editableHtml?: string;
  wordSettings?: WordPageSettings;
  bookmarks?: number[];
  lastReadPage?: number;
  versions: DocumentVersion[];
  sha256Seal?: string;
  isVaultLocked?: boolean;
  vaultSalt?: string;
  vaultIv?: string;
}

export interface PdfEditorState {
  replacements: TextReplacementEdit[];
  addedTexts: AddedTextBox[];
  addedImages: AddedImageOverlay[];
  annotations: AnnotationOverlay[];
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

export type PdfFontFamily =
  | 'arial'
  | 'calibri'
  | 'cambria'
  | 'times'
  | 'georgia'
  | 'verdana'
  | 'tahoma'
  | 'garamond'
  | 'trebuchet'
  | 'courier'
  | 'bengali'
  | 'sans'
  | 'serif'
  | 'mono';

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
  fontFamily: PdfFontFamily;
  color: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  align: 'left' | 'center' | 'right';
  letterSpacing: number;
  backgroundColor?: string;
}

export interface PdfFormFieldDescriptor {
  name: string;
  pageNumber: number;
  kind: 'text' | 'checkbox' | 'dropdown' | 'radio';
  value: string;
  checked: boolean;
  options?: string[];
  /** Unrotated top-left viewport coordinates at scale 1 */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AddedTextBox {
  id: string;
  pageNumber: number;
  text: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
  fontFamily: PdfFontFamily;
  color: string;
  backgroundColor?: string;
  borderColor?: string;
  rotation?: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  align: 'left' | 'center' | 'right';
  letterSpacing: number;
  zIndex?: number;
  layerPlacement?: 'front' | 'behind';
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
  opacity?: number;
  flipX?: boolean;
  flipY?: boolean;
  brightness?: number;
  contrast?: number;
  grayscale?: boolean;
  borderRadius?: number;
  borderColor?: string;
  borderWidth?: number;
  lockAspect?: boolean;
  zIndex?: number;
  layerPlacement?: 'front' | 'behind';
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
    | 'whiteout'
    | 'sticky'
    | 'signature'
    | 'stamp';
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  strokeWidth?: number;
  opacity?: number;
  fillColor?: string;
  fontSize?: number;
  lineStyle?: 'solid' | 'dashed';
  arrowStyle?: 'single' | 'double' | 'line';
  rotation?: number;
  points?: Array<{ x: number; y: number }>;
  comment?: string;
  stickyArrow?:
    | 'left'
    | 'right'
    | 'top'
    | 'bottom'
    | 'top-left'
    | 'top-right'
    | 'bottom-left'
    | 'bottom-right'
    | 'none';
  stickyTipX?: number;
  stickyTipY?: number;
  author?: string;
  dateStr?: string;
  signatureDataUrl?: string;
  signerName?: string;
  zIndex?: number;
  layerPlacement?: 'front' | 'behind';
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
  | { type: 'toolRunner'; toolId: string; preselectedDocId?: string };
