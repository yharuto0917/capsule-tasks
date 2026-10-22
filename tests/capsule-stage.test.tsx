import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/client/app';
import { CapsuleMachineVisual } from '../src/client/components/capsule-machine-visual';
import { CapsuleStage } from '../src/client/components/capsule-stage';
import { DEFAULT_INITIAL_CAPSULE_TASKS, type CapsuleTask } from '../src/shared/schemas';

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CapsuleMachineVisual (FR-06: 筐体内の残りカプセル視覚表現・一覧廃止)', () => {
  it('未完了タスク配列を渡してもタスク名リストは一切表示せず、カラフルな玉イラストと残数バッジのみを表示する', () => {
    render(<CapsuleMachineVisual capsules={DEFAULT_INITIAL_CAPSULE_TASKS} />);

    expect(screen.getByTestId('capsule-machine-visual')).toBeInTheDocument();
    expect(screen.getByTestId('machine-dome-indicator')).toHaveTextContent('3');
    expect(screen.getAllByTestId('machine-capsule-ball')).toHaveLength(3);

    // FR-06: 未完了タスクのタイトル一覧はDOM上に一切表示しない
    for (const task of DEFAULT_INITIAL_CAPSULE_TASKS) {
      expect(screen.queryByText(task.title)).not.toBeInTheDocument();
    }
  });

  it('残りカプセルが0個のときは空ドームメッセージを表示し、玉イラストを表示しない', () => {
    render(<CapsuleMachineVisual capsules={[]} />);

    expect(screen.getByTestId('machine-dome-indicator')).toHaveTextContent('空っぽ');
    expect(screen.queryAllByTestId('machine-capsule-ball')).toHaveLength(0);
  });

  it('カプセルが多数ある場合は最大表示玉数に丸め、残りの個数を +N バッジで抽象表示する', () => {
    const manyCapsules: CapsuleTask[] = Array.from({ length: 10 }, (_, idx) => ({
      ...DEFAULT_INITIAL_CAPSULE_TASKS[idx % DEFAULT_INITIAL_CAPSULE_TASKS.length],
      id: `cap_many_${idx}`,
      title: `非表示であるべきタスク_${idx}`,
    }));

    render(<CapsuleMachineVisual capsules={manyCapsules} />);

    expect(screen.getByTestId('machine-dome-indicator')).toHaveTextContent('10');
    expect(screen.getAllByTestId('machine-capsule-ball').length).toBeLessThanOrEqual(6);
    expect(screen.getByTestId('machine-capsule-overflow')).toHaveTextContent('+4');
    expect(screen.queryByText('非表示であるべきタスク_0')).not.toBeInTheDocument();
  });
});

describe('CapsuleStage (FR-06, FR-07, FR-09, FR-10: 1カプセル表示・クラック・スワイプ)', () => {
  const sampleGoldTask: CapsuleTask = DEFAULT_INITIAL_CAPSULE_TASKS[0];
  const sampleBlueTask: CapsuleTask = DEFAULT_INITIAL_CAPSULE_TASKS[1];

  it('目の前の1カプセルのみを大きく表示し、色に応じた3Dグラデーションとレア度バッジを描画する', () => {
    render(
      <CapsuleStage
        activeCapsule={sampleGoldTask}
        remainingCount={3}
        isUpdating={false}
        onCrack={vi.fn()}
        onPass={vi.fn()}
        onRecycle={vi.fn()}
      />,
    );

    expect(screen.getByTestId('active-capsule-title')).toHaveTextContent(
      '企画書ドラフトを提出する',
    );
    expect(screen.getByTestId('three-capsule-canvas')).toHaveAttribute(
      'data-capsule-color',
      'gold',
    );
    expect(screen.getByTestId('capsule-3d-shell')).toHaveAttribute('data-capsule-color', 'gold');
    expect(screen.getByTestId('capsule-crack-svg')).toHaveAttribute('data-crack-step', '0');
  });

  it('タップ連打（3回タップ）で段階的にクラックSVG（0→1→2→3）が進行し、3回目でStage 3演出とともに開封完了が1回発火する', async () => {
    const onCrack = vi.fn().mockResolvedValue(undefined);
    const onCrackStep = vi.fn();

    render(
      <CapsuleStage
        activeCapsule={sampleGoldTask}
        remainingCount={3}
        isUpdating={false}
        onCrack={onCrack}
        onCrackStep={onCrackStep}
        onPass={vi.fn()}
        onRecycle={vi.fn()}
      />,
    );

    const capsuleBtn = screen.getByTestId('active-capsule-button');

    // 1回目タップ: ヒビ割れ 1/3
    fireEvent.click(capsuleBtn);
    expect(screen.getByTestId('capsule-crack-svg')).toHaveAttribute('data-crack-step', '1');
    expect(screen.getByTestId('crack-layer-1')).toBeInTheDocument();
    expect(onCrackStep).toHaveBeenCalledWith(1);
    expect(onCrack).not.toHaveBeenCalled();

    // 2回目タップ: ヒビ割れ 2/3
    fireEvent.click(capsuleBtn);
    expect(screen.getByTestId('capsule-crack-svg')).toHaveAttribute('data-crack-step', '2');
    expect(screen.getByTestId('crack-layer-2')).toBeInTheDocument();
    expect(onCrackStep).toHaveBeenCalledWith(2);
    expect(onCrack).not.toHaveBeenCalled();

    // 3回目タップ: Stage 3 閃光スターバーストが表示され、パカッと割れて開封完了が1回だけ発火
    fireEvent.click(capsuleBtn);
    expect(screen.getByTestId('capsule-crack-svg')).toHaveAttribute('data-crack-step', '3');
    expect(screen.getByTestId('crack-layer-3')).toBeInTheDocument();
    await waitFor(() => expect(onCrack).toHaveBeenCalledTimes(1));

    // 4回目・5回目を過剰連打しても同一カプセルに対して二重発火しない
    fireEvent.click(capsuleBtn);
    fireEvent.click(capsuleBtn);
    expect(onCrack).toHaveBeenCalledTimes(1);
  });

  it('1秒長押し（1000msホールド）で段階的にヒビが入り、自動的に開封完了が発火して直後のclickで二重発火しない', () => {
    vi.useFakeTimers();
    const onCrack = vi.fn();
    const onCrackStep = vi.fn();

    render(
      <CapsuleStage
        activeCapsule={sampleGoldTask}
        remainingCount={3}
        isUpdating={false}
        onCrack={onCrack}
        onCrackStep={onCrackStep}
        onPass={vi.fn()}
        onRecycle={vi.fn()}
      />,
    );

    const capsuleBtn = screen.getByTestId('active-capsule-button');

    // 長押し開始
    fireEvent.pointerDown(capsuleBtn, { pointerId: 1, clientX: 200, clientY: 200 });

    // 350ms経過: ヒビ割れ 1/3
    act(() => {
      vi.advanceTimersByTime(350);
    });
    expect(screen.getByTestId('capsule-crack-svg')).toHaveAttribute('data-crack-step', '1');
    expect(onCrackStep).toHaveBeenCalledWith(1);
    expect(onCrack).not.toHaveBeenCalled();

    // 700ms経過: ヒビ割れ 2/3
    act(() => {
      vi.advanceTimersByTime(350);
    });
    expect(screen.getByTestId('capsule-crack-svg')).toHaveAttribute('data-crack-step', '2');
    expect(onCrackStep).toHaveBeenCalledWith(2);
    expect(onCrack).not.toHaveBeenCalled();

    // 1000ms到達: Stage 3 になって開封完了が発火
    act(() => {
      vi.advanceTimersByTime(350);
    });
    expect(screen.getByTestId('capsule-crack-svg')).toHaveAttribute('data-crack-step', '3');
    expect(screen.getByTestId('crack-layer-3')).toBeInTheDocument();
    expect(onCrack).toHaveBeenCalledTimes(1);

    // 長押し完了後に指を離して合成clickが発生しても二重発火しない
    fireEvent.pointerUp(capsuleBtn, { pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.click(capsuleBtn);
    expect(onCrack).toHaveBeenCalledTimes(1);
  });

  it('長押しが1秒未満（200ms）で中断された場合は長押し開封完了が発火しない', () => {
    vi.useFakeTimers();
    const onCrack = vi.fn();

    render(
      <CapsuleStage
        activeCapsule={sampleGoldTask}
        remainingCount={3}
        isUpdating={false}
        onCrack={onCrack}
        onPass={vi.fn()}
        onRecycle={vi.fn()}
      />,
    );

    const capsuleBtn = screen.getByTestId('active-capsule-button');

    fireEvent.pointerDown(capsuleBtn, { pointerId: 1, clientX: 200, clientY: 200 });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    fireEvent.pointerUp(capsuleBtn, { pointerId: 1, clientX: 200, clientY: 200 });

    // その後さらに時間が経過しても長押しタイマーは破棄されているため発火しない
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onCrack).not.toHaveBeenCalled();
  });

  it('左スワイプで先送り（onPass）が発火し、長押しタイマーや合成clickが誤発火しない（FR-07）', () => {
    vi.useFakeTimers();
    const onCrack = vi.fn();
    const onPass = vi.fn();
    const onRecycle = vi.fn();

    render(
      <CapsuleStage
        activeCapsule={sampleGoldTask}
        remainingCount={3}
        isUpdating={false}
        onCrack={onCrack}
        onPass={onPass}
        onRecycle={onRecycle}
      />,
    );

    const capsuleBtn = screen.getByTestId('active-capsule-button');

    fireEvent.pointerDown(capsuleBtn, { pointerId: 1, clientX: 220, clientY: 200 });
    fireEvent.pointerMove(capsuleBtn, { pointerId: 1, clientX: 120, clientY: 205 });

    // ドラッグ中は長押しタイマーがキャンセルされていること
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(onCrack).not.toHaveBeenCalled();

    fireEvent.pointerUp(capsuleBtn, { pointerId: 1, clientX: 120, clientY: 205 });
    fireEvent.click(capsuleBtn);

    expect(onPass).toHaveBeenCalledTimes(1);
    expect(onRecycle).not.toHaveBeenCalled();
    expect(onCrack).not.toHaveBeenCalled();
  });

  it('ゴミ箱方向（右）スワイプでリサイクル破棄（onRecycle）が発火する（FR-09）', () => {
    const onCrack = vi.fn();
    const onPass = vi.fn();
    const onRecycle = vi.fn();

    render(
      <CapsuleStage
        activeCapsule={sampleGoldTask}
        remainingCount={3}
        isUpdating={false}
        onCrack={onCrack}
        onPass={onPass}
        onRecycle={onRecycle}
      />,
    );

    const capsuleBtn = screen.getByTestId('active-capsule-button');

    fireEvent.pointerDown(capsuleBtn, { pointerId: 1, clientX: 150, clientY: 200 });
    fireEvent.pointerMove(capsuleBtn, { pointerId: 1, clientX: 245, clientY: 200 });
    fireEvent.pointerUp(capsuleBtn, { pointerId: 1, clientX: 245, clientY: 200 });
    fireEvent.click(capsuleBtn);

    expect(onRecycle).toHaveBeenCalledTimes(1);
    expect(onPass).not.toHaveBeenCalled();
    expect(onCrack).not.toHaveBeenCalled();
  });

  it('スワイプ移動量が閾値未満かつ低速な場合はスナップバックし、onPass も onRecycle も発火しない', () => {
    const onCrack = vi.fn();
    const onPass = vi.fn();
    const onRecycle = vi.fn();

    render(
      <CapsuleStage
        activeCapsule={sampleGoldTask}
        remainingCount={3}
        isUpdating={false}
        onCrack={onCrack}
        onPass={onPass}
        onRecycle={onRecycle}
      />,
    );

    const capsuleBtn = screen.getByTestId('active-capsule-button');

    fireEvent.pointerDown(capsuleBtn, { pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(capsuleBtn, { pointerId: 1, clientX: 185, clientY: 200 });
    fireEvent.pointerUp(capsuleBtn, { pointerId: 1, clientX: 185, clientY: 200 });
    fireEvent.click(capsuleBtn);

    expect(onPass).not.toHaveBeenCalled();
    expect(onRecycle).not.toHaveBeenCalled();
    expect(onCrack).not.toHaveBeenCalled();
  });

  it('ドーム領域やタスク名スリップ上から横スワイプを開始し、要素外（window）で指を離してもスワイプ判定が成立する', () => {
    const onPass = vi.fn();
    const onRecycle = vi.fn();

    render(
      <CapsuleStage
        activeCapsule={sampleGoldTask}
        remainingCount={3}
        isUpdating={false}
        onCrack={vi.fn()}
        onPass={onPass}
        onRecycle={onRecycle}
      />,
    );

    const titleSlip = screen.getByTestId('active-capsule-title');

    // タスク名スリップ上でスワイプ開始し、window 上で移動・解放
    fireEvent.pointerDown(titleSlip, { pointerId: 5, clientX: 220, clientY: 320 });
    fireEvent.pointerMove(window, { pointerId: 5, clientX: 150, clientY: 322 });
    fireEvent.pointerUp(window, { pointerId: 5, clientX: 150, clientY: 322 });

    expect(onPass).toHaveBeenCalledTimes(1);
    expect(onRecycle).not.toHaveBeenCalled();
  });

  it('TouchEvent（touchStart / touchMove / touchEnd）による横スワイプでも確実に先送り・破棄が判定される', () => {
    const onPass = vi.fn();
    const onRecycle = vi.fn();

    render(
      <CapsuleStage
        activeCapsule={sampleGoldTask}
        remainingCount={3}
        isUpdating={false}
        onCrack={vi.fn()}
        onPass={onPass}
        onRecycle={onRecycle}
      />,
    );

    const stageDome = screen.getByTestId('capsule-stage-dome');

    // 左タッチスワイプ -> onPass
    fireEvent.touchStart(stageDome, {
      touches: [{ identifier: 1, clientX: 240, clientY: 200 }],
    });
    fireEvent.touchMove(stageDome, {
      touches: [{ identifier: 1, clientX: 170, clientY: 202 }],
    });
    fireEvent.touchEnd(stageDome, {
      changedTouches: [{ identifier: 1, clientX: 170, clientY: 202 }],
    });

    expect(onPass).toHaveBeenCalledTimes(1);

    // 右タッチスワイプ -> onRecycle
    fireEvent.touchStart(stageDome, {
      touches: [{ identifier: 2, clientX: 140, clientY: 200 }],
    });
    fireEvent.touchMove(stageDome, {
      touches: [{ identifier: 2, clientX: 210, clientY: 202 }],
    });
    fireEvent.touchEnd(stageDome, {
      changedTouches: [{ identifier: 2, clientX: 210, clientY: 202 }],
    });

    expect(onRecycle).toHaveBeenCalledTimes(1);
  });

  it('activeCapsule が別のカプセルに切り替わった際、およびパスで巡回して再排出された際にクラック段階が 0/3 にリセットされる', () => {
    const { rerender } = render(
      <CapsuleStage
        activeCapsule={sampleGoldTask}
        remainingCount={3}
        isUpdating={false}
        onCrack={vi.fn()}
        onPass={vi.fn()}
        onRecycle={vi.fn()}
      />,
    );

    const capsuleBtn = screen.getByTestId('active-capsule-button');
    fireEvent.click(capsuleBtn);
    expect(screen.getByTestId('capsule-crack-svg')).toHaveAttribute('data-crack-step', '1');

    // 別カプセルへ切り替え
    rerender(
      <CapsuleStage
        activeCapsule={sampleBlueTask}
        remainingCount={3}
        isUpdating={false}
        onCrack={vi.fn()}
        onPass={vi.fn()}
        onRecycle={vi.fn()}
      />,
    );

    expect(screen.getByTestId('capsule-crack-svg')).toHaveAttribute('data-crack-step', '0');

    // パス巡回後に元のカプセル（skipCount: 1）が再び先頭に戻ってきた場合も 0/3 に初期化されていること
    rerender(
      <CapsuleStage
        activeCapsule={{ ...sampleGoldTask, skipCount: 1 }}
        remainingCount={3}
        isUpdating={false}
        onCrack={vi.fn()}
        onPass={vi.fn()}
        onRecycle={vi.fn()}
      />,
    );

    expect(screen.getByTestId('capsule-crack-svg')).toHaveAttribute('data-crack-step', '0');
    fireEvent.click(screen.getByTestId('active-capsule-button'));
    expect(screen.getByTestId('capsule-crack-svg')).toHaveAttribute('data-crack-step', '1');
  });
});

describe('App メイン画面統合操作 (開封・左スワイプ先送り・リサイクル＋5コイントースト)', () => {
  it('左スワイプで次のカプセルへ切り替わり、ゴミ箱スワイプで「リサイクル完了！＋5コイン獲得」トーストとともに破棄される', async () => {
    render(<App />);

    expect(screen.getByTestId('active-capsule-title')).toHaveTextContent(
      '企画書ドラフトを提出する',
    );
    expect(screen.getByTestId('status-coins')).toHaveTextContent('150');

    // 1. 左スワイプで先送り（FR-07）
    const capsuleBtn = screen.getByTestId('active-capsule-button');
    fireEvent.pointerDown(capsuleBtn, { pointerId: 1, clientX: 220, clientY: 200 });
    fireEvent.pointerMove(capsuleBtn, { pointerId: 1, clientX: 120, clientY: 200 });
    fireEvent.pointerUp(capsuleBtn, { pointerId: 1, clientX: 120, clientY: 200 });

    await waitFor(() =>
      expect(screen.getByTestId('active-capsule-title')).toHaveTextContent(
        '溜まった洗濯物をたたむ',
      ),
    );

    // 2. 右（ゴミ箱）スワイプでリサイクル破棄（FR-09）
    const nextCapsuleBtn = screen.getByTestId('active-capsule-button');
    fireEvent.pointerDown(nextCapsuleBtn, { pointerId: 2, clientX: 140, clientY: 200 });
    fireEvent.pointerMove(nextCapsuleBtn, { pointerId: 2, clientX: 240, clientY: 200 });
    fireEvent.pointerUp(nextCapsuleBtn, { pointerId: 2, clientX: 240, clientY: 200 });

    await waitFor(() => expect(screen.getByTestId('status-coins')).toHaveTextContent('155'));
    expect(screen.getByTestId('recycle-toast')).toHaveTextContent('リサイクル完了！＋5コイン獲得');
    expect(screen.getByTestId('active-capsule-title')).toHaveTextContent(
      '経費精算の領収書をアップロード',
    );
  });

  it('カプセルを3回タップ連打すると開封完了し、コインとコンボが増加して次のカプセルが排出される', async () => {
    render(<App />);

    expect(screen.getByTestId('status-coins')).toHaveTextContent('150');
    expect(screen.getByTestId('status-combo')).toHaveTextContent('3');

    const capsuleBtn = screen.getByTestId('active-capsule-button');
    fireEvent.click(capsuleBtn);
    fireEvent.click(capsuleBtn);
    fireEvent.click(capsuleBtn);

    await waitFor(() => expect(screen.getByTestId('status-coins')).toHaveTextContent('180'));
    expect(screen.getByTestId('status-combo')).toHaveTextContent('4');
    expect(screen.getByTestId('active-capsule-title')).toHaveTextContent('溜まった洗濯物をたたむ');
  });
});
