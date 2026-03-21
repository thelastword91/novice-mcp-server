#!/usr/bin/env node

/**
 * Novice MCP Server
 *
 * Claude Code에서 Novice 프로젝트에 파일을 업로드하고
 * 피드백을 조회하는 MCP 도구 서버
 *
 * 환경변수:
 *   NOVICE_API_URL   — Novice 서버 URL (기본: https://novice.up.railway.app)
 *   NOVICE_API_TOKEN — API 토큰 (nvs_xxx...)
 *   NOVICE_PROJECT_ID — 기본 프로젝트 ID (선택, 하위 호환)
 *   NOVICE_PROJECT_NAME — 기본 프로젝트 이름 (선택, Option B 권장)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import picomatch from 'picomatch';
import { NoviceClient, type NoviceFile } from './novice-client.js';

const API_URL = process.env.NOVICE_API_URL || 'https://novice.up.railway.app';
const API_TOKEN = process.env.NOVICE_API_TOKEN || '';
const DEFAULT_PROJECT_ID = process.env.NOVICE_PROJECT_ID || '';
const DEFAULT_PROJECT_NAME = process.env.NOVICE_PROJECT_NAME || '';

if (!API_TOKEN) {
  console.error('NOVICE_API_TOKEN 환경변수가 필요합니다.');
  process.exit(1);
}

const client = new NoviceClient(API_URL, API_TOKEN);

const server = new McpServer({
  name: 'novice',
  version: '0.2.0',
});

// ===========================
// 도구 1: novice_upload
// ===========================

server.tool(
  'novice_upload',
  'Novice에 업로드합니다. 폴더를 업로드할 때는 반드시 dir_path를 사용하세요 — MCP 서버가 파일을 직접 읽어 가장 빠릅니다. files는 코드 조각 등 소량 데이터에만 사용하세요. phase를 지정하지 않으면 사용자에게 기획 모드(planning)와 개발 모드(development) 중 선택을 요청하세요.',
  {
    dir_path: z.string().optional().describe('업로드할 디렉토리 절대 경로 (폴더 업로드 시 필수, 가장 빠름). 예: /Users/me/my-project'),
    include: z.array(z.string()).optional().describe('포함할 glob 패턴 (dir_path 사용 시). 예: ["*.html", "*.css", "*.js"]'),
    exclude: z.array(z.string()).optional().describe('추가 제외 glob 패턴 (dir_path 사용 시)'),
    max_depth: z.number().int().min(1).max(20).optional().describe('최대 탐색 깊이 (기본: 10, dir_path 사용 시)'),
    files: z.array(z.object({
      name: z.string().describe('파일명'),
      content: z.string().describe('파일 내용'),
    })).optional().describe('직접 전달할 파일 목록 (dir_path 미사용 시에만)'),
    project_name: z.string().optional().describe('프로젝트 이름 (자동 매칭/생성)'),
    project_id: z.string().uuid().optional().describe('프로젝트 ID (직접 지정, 선택)'),
    message: z.string().optional().describe('업로드 메시지 (버전 설명)'),
    phase: z.enum(['planning', 'development']).optional().describe('프로젝트 모드. planning=UI 프로토타입(외부 API 차단), development=실제 기능 테스트(Firebase/OAuth 등 허용). 사용자가 지정하지 않으면 반드시 물어볼 것'),
  },
  async ({ dir_path, include, exclude, max_depth, files, project_name, project_id, message, phase }) => {
    // 입력 검증
    if (!dir_path && (!files || files.length === 0)) {
      return {
        content: [{ type: 'text' as const, text: 'dir_path 또는 files가 필요합니다. 폴더 업로드는 dir_path를 사용하세요 (권장).' }],
        isError: true,
      };
    }

    const pName = project_name || DEFAULT_PROJECT_NAME;
    const pId = project_id || DEFAULT_PROJECT_ID;

    if (!pName && !pId) {
      return {
        content: [{ type: 'text' as const, text: 'project_name 또는 project_id가 필요합니다. 파라미터로 전달하거나 NOVICE_PROJECT_NAME 환경변수를 설정해주세요.' }],
        isError: true,
      };
    }

    // 파일 수집
    let uploadFiles: NoviceFile[];
    let warnings: string[] = [];
    let skipped = 0;

    if (dir_path) {
      // 디렉토리 모드: MCP 서버가 직접 파일을 읽음
      try {
        const dirStat = await stat(dir_path);
        if (!dirStat.isDirectory()) {
          return { content: [{ type: 'text' as const, text: `경로가 디렉토리가 아닙니다: ${dir_path}` }], isError: true };
        }
      } catch {
        return { content: [{ type: 'text' as const, text: `디렉토리를 찾을 수 없습니다: ${dir_path}` }], isError: true };
      }

      const result = await collectFiles(dir_path, { include, exclude, maxDepth: max_depth ?? 10 });
      if (result.files.length === 0) {
        const patternInfo = include ? `\n포함 패턴: ${include.join(', ')}` : '';
        return { content: [{ type: 'text' as const, text: `매칭되는 파일이 없습니다.${patternInfo}\n디렉토리: ${dir_path}\n건너뛴 파일: ${result.skipped}개` }], isError: true };
      }
      if (result.files.length > MAX_FILE_COUNT) {
        return { content: [{ type: 'text' as const, text: `파일이 너무 많습니다: ${result.files.length}개 (최대 ${MAX_FILE_COUNT}개)\ninclude 패턴을 좁히거나 exclude를 추가하세요.` }], isError: true };
      }
      uploadFiles = result.files;
      warnings = result.warnings;
      skipped = result.skipped;
    } else {
      // 직접 파일 모드
      uploadFiles = files!;
    }

    // 유저 플로우 순서로 정렬 (HTML 파일 우선, 파일명 기반 휴리스틱)
    uploadFiles = sortByUserFlow(uploadFiles);

    // 업로드
    try {
      const result = await client.upload({
        project_name: pName || undefined,
        project_id: pId || undefined,
        files: uploadFiles,
        message,
        phase,
      });

      const statusMsg = result.created ? '새 프로젝트 생성됨' : '기존 프로젝트 업데이트';
      const phaseLabel = phase === 'planning' ? '기획 모드' : phase === 'development' ? '개발 모드' : '기본';
      const fileList = uploadFiles.map(f => f.name).join(', ');
      const warningText = warnings.length > 0 ? `\n\n⚠️ 경고:\n${warnings.map(w => `  - ${w}`).join('\n')}` : '';
      const skippedText = dir_path ? `\n건너뛴 파일: ${skipped}개` : '';

      return {
        content: [{
          type: 'text' as const,
          text: `업로드 성공! 버전 ${result.version_number} 생성 (파일 ${result.files_count}개)\n프로젝트: ${result.project_name} (${statusMsg}, ${phaseLabel})\nID: ${result.project_id}\n\n업로드된 파일:\n  ${fileList}${skippedText}${warningText}`,
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `업로드 실패: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

// ===========================
// 도구 2: novice_get_feedback
// ===========================

server.tool(
  'novice_get_feedback',
  '프로젝트의 공유 페이지에서 받은 피드백 코멘트를 조회합니다.',
  {
    project_id: z.string().uuid().optional().describe('프로젝트 ID (생략 시 NOVICE_PROJECT_ID 환경변수 사용)'),
    unresolved_only: z.boolean().optional().default(false).describe('미해결 피드백만 조회'),
  },
  async ({ project_id, unresolved_only }) => {
    const pid = project_id || DEFAULT_PROJECT_ID;
    if (!pid) {
      return {
        content: [{ type: 'text' as const, text: 'project_id가 필요합니다.' }],
        isError: true,
      };
    }

    try {
      let comments = await client.getFeedback(pid);

      if (unresolved_only) {
        comments = comments.filter(c => !c.is_resolved);
      }

      if (comments.length === 0) {
        return {
          content: [{ type: 'text' as const, text: '피드백이 없습니다.' }],
        };
      }

      const summary = comments.map((c, i) =>
        `${i + 1}. [${c.is_resolved ? '해결됨' : '미해결'}] ${c.author_name}: "${c.comment_text}"\n   위치: ${c.css_selector} (${c.page_name})\n   날짜: ${c.created_at}`
      ).join('\n\n');

      return {
        content: [{ type: 'text' as const, text: `피드백 ${comments.length}건:\n\n${summary}` }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `피드백 조회 실패: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

// ===========================
// 도구 3: novice_get_share_url
// ===========================

server.tool(
  'novice_get_share_url',
  '프로젝트의 공유 URL을 조회합니다. 클라이언트에게 전달할 수 있는 프리뷰 링크입니다.',
  {
    project_id: z.string().uuid().optional().describe('프로젝트 ID (생략 시 NOVICE_PROJECT_ID 환경변수 사용)'),
  },
  async ({ project_id }) => {
    const pid = project_id || DEFAULT_PROJECT_ID;
    if (!pid) {
      return {
        content: [{ type: 'text' as const, text: 'project_id가 필요합니다.' }],
        isError: true,
      };
    }

    try {
      const links = await client.getShareLinks(pid);
      const activeLinks = links.filter(l => l.is_active);

      if (activeLinks.length === 0) {
        return {
          content: [{ type: 'text' as const, text: '활성 공유 링크가 없습니다. Novice 웹에서 공유 링크를 생성해주세요.' }],
        };
      }

      const urls = activeLinks.map(l =>
        `- ${API_URL}/share/${l.share_token} (v${l.version_number}, ${l.created_at})`
      ).join('\n');

      return {
        content: [{ type: 'text' as const, text: `공유 URL:\n${urls}` }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `공유 URL 조회 실패: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

// ===========================
// 유저 플로우 순서 정렬
// ===========================

const FLOW_PRIORITY: Record<string, number> = {
  'index': 0, 'home': 0, 'landing': 0, 'main': 0,
  'login': 10, 'signin': 10, 'sign-in': 10,
  'signup': 11, 'register': 11, 'sign-up': 11,
  'onboarding': 20,
  'dashboard': 30,
  'profile': 80, 'settings': 80, 'account': 80,
  'mypage': 80, 'my-page': 80,
  'error': 90, '404': 90, '500': 90,
  'admin': 95,
};

const DEFAULT_PRIORITY = 50;

function sortByUserFlow(files: NoviceFile[]): NoviceFile[] {
  const htmlFiles: NoviceFile[] = [];
  const otherFiles: NoviceFile[] = [];

  for (const f of files) {
    if (/\.html?$/i.test(f.name)) {
      htmlFiles.push(f);
    } else {
      otherFiles.push(f);
    }
  }

  htmlFiles.sort((a, b) => {
    const keyA = (a.name.split('/').pop() || a.name).replace(/\.html?$/i, '').toLowerCase();
    const keyB = (b.name.split('/').pop() || b.name).replace(/\.html?$/i, '').toLowerCase();
    const prioA = FLOW_PRIORITY[keyA] ?? DEFAULT_PRIORITY;
    const prioB = FLOW_PRIORITY[keyB] ?? DEFAULT_PRIORITY;
    if (prioA !== prioB) return prioA - prioB;
    return keyA.localeCompare(keyB);
  });

  return [...htmlFiles, ...otherFiles];
}

// ===========================
// 디렉토리 파일 수집 유틸리티
// ===========================

const DEFAULT_EXCLUDES = [
  'node_modules/**', '.git/**', 'dist/**', '.next/**',
  '.env*', '*.lock', 'package-lock.json', '.DS_Store',
  '__pycache__/**', '.vscode/**', '.idea/**',
];

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_FILE_COUNT = 50;

function isBinaryBuffer(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8192);
  return sample.includes(0);
}

interface CollectResult {
  files: NoviceFile[];
  warnings: string[];
  skipped: number;
}

async function collectFiles(
  rootDir: string,
  options: { include?: string[]; exclude?: string[]; maxDepth: number },
): Promise<CollectResult> {
  const allExcludes = [...DEFAULT_EXCLUDES, ...(options.exclude || [])];
  const includeMatcher = options.include ? picomatch(options.include) : null;
  const excludeMatcher = picomatch(allExcludes);

  const files: NoviceFile[] = [];
  const warnings: string[] = [];
  let skipped = 0;

  async function walk(dir: string, depth: number) {
    if (depth > options.maxDepth) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      warnings.push(`읽기 실패: ${relative(rootDir, dir)}`);
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relPath = relative(rootDir, fullPath).replace(/\\/g, '/');

      if (excludeMatcher(relPath)) {
        skipped++;
        continue;
      }

      if (entry.isDirectory()) {
        // 디렉토리 이름 자체가 제외 대상인지 확인
        if (excludeMatcher(entry.name + '/')) {
          skipped++;
          continue;
        }
        await walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        if (includeMatcher && !includeMatcher(relPath)) {
          skipped++;
          continue;
        }

        try {
          const fileStat = await stat(fullPath);
          if (fileStat.size > MAX_FILE_SIZE) {
            warnings.push(`스킵 (>5MB): ${relPath} (${(fileStat.size / 1024 / 1024).toFixed(1)}MB)`);
            skipped++;
            continue;
          }

          const buffer = await readFile(fullPath);
          if (isBinaryBuffer(buffer)) {
            skipped++;
            continue;
          }

          files.push({ name: relPath, content: buffer.toString('utf-8') });
        } catch {
          warnings.push(`읽기 실패: ${relPath}`);
          skipped++;
        }
      }
    }
  }

  await walk(rootDir, 0);
  return { files, warnings, skipped };
}

// ===========================
// 프로세스 안정성 (Server disconnected 방지)
// ===========================

process.on('uncaughtException', (err) => {
  console.error('[novice-mcp] uncaughtException:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[novice-mcp] unhandledRejection:', reason);
});
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

// ===========================
// 서버 시작
// ===========================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('MCP 서버 시작 실패:', error);
  process.exit(1);
});
