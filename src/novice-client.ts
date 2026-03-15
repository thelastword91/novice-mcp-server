/**
 * Novice API HTTP 클라이언트
 * MCP 서버에서 Novice 서버 API를 호출하는 래퍼
 */

export interface NoviceFile {
  name: string;
  content: string;
}

export interface UploadResult {
  success: boolean;
  version_number: number;
  project_id: string;
  project_name: string;
  files_count: number;
  created: boolean;
}

export interface ShareLink {
  id: string;
  share_token: string;
  version_number: number;
  is_active: boolean;
  created_at: string;
}

export interface ShareComment {
  id: string;
  css_selector: string;
  element_tag: string | null;
  comment_text: string;
  author_name: string;
  is_resolved: boolean;
  created_at: string;
  page_name: string;
}

export class NoviceClient {
  private baseUrl: string;
  private apiToken: string;

  constructor(baseUrl: string, apiToken: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiToken = apiToken;
  }

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    let res: Response;
    try {
      res = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(30_000),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiToken}`,
          ...options?.headers,
        },
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new Error(`Novice API 타임아웃 (30초): ${url}`);
      }
      throw error;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Novice API 에러 (${res.status}): ${body}`);
    }

    return res.json() as Promise<T>;
  }

  // Top-level upload (Option B: project_name 기반 자동 매칭/생성)
  async upload(options: { project_id?: string; project_name?: string; files: NoviceFile[]; message?: string; phase?: 'planning' | 'development' }): Promise<UploadResult> {
    return this.request<UploadResult>('/api/upload', {
      method: 'POST',
      body: JSON.stringify(options),
    });
  }

  // Legacy: project_id 기반 직접 업로드
  async uploadToProject(projectId: string, files: NoviceFile[], message?: string): Promise<UploadResult> {
    return this.request<UploadResult>(`/api/projects/${projectId}/upload`, {
      method: 'POST',
      body: JSON.stringify({ files, message }),
    });
  }

  async getShareLinks(projectId: string): Promise<ShareLink[]> {
    return this.request<ShareLink[]>(`/api/projects/${projectId}/share`);
  }

  async getFeedback(projectId: string): Promise<ShareComment[]> {
    return this.request<ShareComment[]>(`/api/projects/${projectId}/feedback`);
  }
}
