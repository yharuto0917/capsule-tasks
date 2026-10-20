import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/client/app';
import { HeaderStatusBar } from '../src/client/components/header-status-bar';
import serverApp from '../src/server/index';

beforeEach(() => {
  window.localStorage.clear();
});

describe('HeaderStatusBar', () => {
  it('所持コイン、連続コンボ数、筐体内の残りカプセル数を正しく表示する', () => {
    render(<HeaderStatusBar coins={240} todayCombo={5} remainingCapsules={7} />);

    expect(screen.getByTestId('status-coins')).toHaveTextContent('240');
    expect(screen.getByTestId('status-combo')).toHaveTextContent('5');
    expect(screen.getByTestId('status-remaining-capsules')).toHaveTextContent('7');
  });
});

describe('App (1画面完結ガチャステージ骨格)', () => {
  it('ToDoリスト一覧を表示せず、常に中央の1カプセルのみと親指操作エリアを表示する', () => {
    render(<App />);

    expect(screen.getByTestId('mobile-stage-container')).toBeInTheDocument();
    expect(screen.getByTestId('header-status-bar')).toBeInTheDocument();
    expect(screen.getByTestId('active-capsule-button')).toBeInTheDocument();
    expect(screen.getByTestId('three-capsule-canvas')).toHaveAttribute(
      'data-capsule-color',
      'gold',
    );
    expect(screen.getByTestId('active-capsule-title')).toHaveTextContent(
      '企画書ドラフトを提出する',
    );
    expect(screen.getByTestId('thumb-action-dock')).toBeInTheDocument();
  });

  it('パスボタン押下で次のカプセルに切り替わり、補充ボタン押下で+10コインが付与される', () => {
    render(<App />);

    expect(screen.getByTestId('status-coins')).toHaveTextContent('150');

    // パスして次のカプセルへ
    fireEvent.click(screen.getByTestId('action-pass-button'));
    expect(screen.getByTestId('active-capsule-title')).toHaveTextContent('溜まった洗濯物をたたむ');
    expect(screen.getByTestId('three-capsule-canvas')).toHaveAttribute(
      'data-capsule-color',
      'blue',
    );

    // カプセル補充で+10コイン
    fireEvent.click(screen.getByTestId('open-supply-sheet-button'));
    expect(screen.getByTestId('status-coins')).toHaveTextContent('160');
  });
});

describe('Hono Server (/api/health)', () => {
  it('GET /api/health がステータスokと使用AIモデル定義を返す', async () => {
    const res = await serverApp.request('/api/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      status: 'ok',
      service: 'capsule-tasks-api',
      models: {
        taskExtraction: 'gemini-3.8-flash',
        medalGeneration: 'gemini-nano-banana-2.1',
      },
      hasApiKey: false,
    });
  });
});
