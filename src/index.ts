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
import { NoviceClient } from './novice-client.js';

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
  '파일들을 Novice 프로젝트에 업로드합니다. project_name으로 자동 매칭되며, 없으면 새 프로젝트가 생성됩니다.',
  {
    project_name: z.string().optional().describe('프로젝트 이름 (자동 매칭/생성, CLAUDE.md의 novice_project_name 사용 권장)'),
    project_id: z.string().uuid().optional().describe('프로젝트 ID (직접 지정, 선택)'),
    files: z.array(z.object({
      name: z.string().describe('파일명 (예: index.html, styles.css)'),
      content: z.string().describe('파일 내용'),
    })).min(1).describe('업로드할 파일 목록'),
    message: z.string().optional().describe('업로드 메시지 (버전 설명)'),
  },
  async ({ project_name, project_id, files, message }) => {
    const pName = project_name || DEFAULT_PROJECT_NAME;
    const pId = project_id || DEFAULT_PROJECT_ID;

    if (!pName && !pId) {
      return {
        content: [{ type: 'text' as const, text: 'project_name 또는 project_id가 필요합니다. 파라미터로 전달하거나 NOVICE_PROJECT_NAME 환경변수를 설정해주세요.' }],
        isError: true,
      };
    }

    try {
      const result = await client.upload({
        project_name: pName || undefined,
        project_id: pId || undefined,
        files,
        message,
      });

      const statusMsg = result.created ? '새 프로젝트 생성됨' : '기존 프로젝트 업데이트';
      return {
        content: [{
          type: 'text' as const,
          text: `업로드 성공! 버전 ${result.version_number} 생성 (파일 ${result.files_count}개)\n프로젝트: ${result.project_name} (${statusMsg})\nID: ${result.project_id}`,
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
