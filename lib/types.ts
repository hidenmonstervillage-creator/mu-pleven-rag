export interface Faculty {
  id: string;
  name: string;
  specialties: Specialty[];
}

export interface Specialty {
  id: string;
  name: string;
  subjects: string[];
}

export interface Document {
  id: string;
  filename: string;
  clean_title: string;
  file_type: 'textbook' | 'lecture';
  faculty_id: string;
  specialty_id: string;
  subject: string;
  storage_url: string | null;
  page_count: number | null;
  created_at: string;
}

export interface Chunk {
  id: string;
  document_id: string;
  content: string;
  page_number: number | null;
  chunk_index: number | null;
  created_at: string;
}

export interface SourceChunk {
  id: string;
  content: string;
  page_number: number | null;
  document_id: string;
  clean_title: string;
  file_type: 'textbook' | 'lecture';
  storage_url: string | null;
  similarity: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources?: SourceChunk[];
  timestamp: number;
}

export interface ConversationHistory {
  id: string;
  title: string;
  messages: ChatMessage[];
  facultyId: string;
  specialtyId: string;
  subject: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChatRequest {
  message: string;
  facultyId: string;
  specialtyId: string;
  subject: string;
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface IngestRequest {
  file: File;
  facultyId: string;
  specialtyId: string;
  subject: string;
  fileType: 'textbook' | 'lecture';
}

export interface IngestResponse {
  success: boolean;
  documentId: string;
  chunksCreated: number;
}
