import type { MedalRarity } from '../../shared/schemas';

export type MedalThinkingLevel = 'minimal' | 'medium';

export interface MedalFrameReference {
  rarity: MedalRarity;
  frameId: string;
  frameNameJa: string;
  frameNameEn: string;
  materialLabel: string;
  thinkingLevel: MedalThinkingLevel;
  mimeType: 'image/png';
  /** Multi-image fusion で gemini-nano-banana-2.1 の input に渡す参照ベース枠画像（Base64 PNG） */
  referenceImageBase64: string;
  /** gemini-nano-banana-2.1 に指示するメダル枠の造形・質感プロンプト */
  frameStylePrompt: string;
  /** UIフォールバック・プレビュー用のSVG Data URL */
  fallbackSvgDataUrl: string;
}

function buildFallbackSvgDataUrl(
  rarity: MedalRarity,
  primaryStop: string,
  secondaryStop: string,
  rimColor: string,
  label: string,
): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
    <defs>
      <radialGradient id="bg_${rarity}" cx="50%" cy="40%" r="60%">
        <stop offset="0%" stop-color="${primaryStop}" />
        <stop offset="100%" stop-color="${secondaryStop}" />
      </radialGradient>
    </defs>
    <rect width="256" height="256" rx="36" fill="#1E1B18" />
    <circle cx="128" cy="128" r="104" fill="url(#bg_${rarity})" stroke="${rimColor}" stroke-width="10" />
    <circle cx="128" cy="128" r="82" fill="none" stroke="#FFFFFF" stroke-opacity="0.55" stroke-width="3" stroke-dasharray="6 4" />
    <polygon points="128,62 144,98 184,102 154,128 162,168 128,148 94,168 102,128 72,102 112,98" fill="#FFFFFF" fill-opacity="0.85" stroke="#1E1B18" stroke-width="3" />
    <rect x="44" y="186" width="168" height="30" rx="15" fill="#1E1B18" stroke="${rimColor}" stroke-width="3" />
    <text x="128" y="206" text-anchor="middle" fill="#FFF8EC" font-family="sans-serif" font-weight="900" font-size="13">${label}</text>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/**
 * レア度（N / R / SR / SSR）ごとのベースメダル枠参照データ（FR-13, FR-14）
 * - N: ブロンズ（thinking_level: "minimal"）
 * - R: シルバー（thinking_level: "minimal"）
 * - SR: ゴールド（thinking_level: "medium"）
 * - SSR: ホログラム・虹（thinking_level: "medium"）
 */
export const MEDAL_FRAME_REFERENCES: Record<MedalRarity, MedalFrameReference> = {
  N: {
    rarity: 'N',
    frameId: 'frame_n_bronze',
    frameNameJa: 'ブロンズメダル枠',
    frameNameEn: 'Classic Bronze Medal Frame',
    materialLabel: 'BRONZE',
    thinkingLevel: 'minimal',
    mimeType: 'image/png',
    // 1x1 ブロンズトーン参照PNG Base64
    referenceImageBase64:
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    frameStylePrompt:
      'Circular antique bronze commemorative medal frame with a warm brushed copper-bronze bezel, embossed laurel wreath border, subtle metallic patina, and a recessed circular center for the task relief motif on a dark velvet display pad.',
    fallbackSvgDataUrl: buildFallbackSvgDataUrl('N', '#FDBA74', '#9A3412', '#F97316', 'BRONZE N'),
  },
  R: {
    rarity: 'R',
    frameId: 'frame_r_silver',
    frameNameJa: 'シルバーメダル枠',
    frameNameEn: 'Polished Silver Medal Frame',
    materialLabel: 'SILVER',
    thinkingLevel: 'minimal',
    mimeType: 'image/png',
    // 1x1 シルバートーン参照PNG Base64
    referenceImageBase64:
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
    frameStylePrompt:
      'Circular polished sterling silver commemorative medal frame with a mirror-chrome beveled rim, star-studded inner ring, crisp metallic reflections, and a sculpted 3D silver relief center on a deep navy velvet cushion.',
    fallbackSvgDataUrl: buildFallbackSvgDataUrl('R', '#F8FAFC', '#64748B', '#CBD5E1', 'SILVER R'),
  },
  SR: {
    rarity: 'SR',
    frameId: 'frame_sr_gold',
    frameNameJa: 'ゴールドメダル枠',
    frameNameEn: 'Royal 24K Gold Medal Frame',
    materialLabel: 'GOLD',
    thinkingLevel: 'medium',
    mimeType: 'image/png',
    // 1x1 ゴールドトーン参照PNG Base64
    referenceImageBase64:
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5/hPwAIAgL/4d1j8wAAAABJRU5ErkJggg==',
    frameStylePrompt:
      'Luxurious 24K gleaming gold commemorative medal frame with an ornate crown-and-laurel sculpted rim, crimson enamel accent ring, radiant golden specular highlights, and a high-relief golden emblem center on a royal red velvet display case.',
    fallbackSvgDataUrl: buildFallbackSvgDataUrl('SR', '#FEF08A', '#B45309', '#FFBE0B', 'GOLD SR'),
  },
  SSR: {
    rarity: 'SSR',
    frameId: 'frame_ssr_hologram',
    frameNameJa: 'ホログラム虹彩勲章枠',
    frameNameEn: 'Prismatic Hologram Rainbow Medal Frame',
    materialLabel: 'HOLOGRAM',
    thinkingLevel: 'medium',
    mimeType: 'image/png',
    // 1x1 ホログラムトーン参照PNG Base64
    referenceImageBase64:
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    frameStylePrompt:
      'Supreme prismatic holographic platinum-and-gold commemorative medal frame with iridescent rainbow foil reflections, diamond-cut crystal gemstones embedded along the rim, celestial sparkles, and an ultra-detailed 3D center relief.',
    fallbackSvgDataUrl: buildFallbackSvgDataUrl(
      'SSR',
      '#F472B6',
      '#38BDF8',
      '#FDE047',
      'HOLOGRAM SSR',
    ),
  },
};

/**
 * 指定されたレア度に対応するベースメダル枠の参照データを取得する
 */
export function getMedalFrameReference(rarity: MedalRarity): MedalFrameReference {
  return MEDAL_FRAME_REFERENCES[rarity] ?? MEDAL_FRAME_REFERENCES.N;
}

/**
 * レア度に応じた Interactions API の `thinking_level` を返す
 * - 通常時（N / R）: `"minimal"`（高速生成優先）
 * - 高レア時（SR / SSR）: `"medium"`（精緻な文字刻印・豪華装飾優先）
 */
export function getThinkingLevelForRarity(rarity: MedalRarity): MedalThinkingLevel {
  return rarity === 'SR' || rarity === 'SSR' ? 'medium' : 'minimal';
}

export const MEDAL_RARITY_STYLE_MAP: Record<
  MedalRarity,
  {
    badgeLabel: string;
    tierLabelJa: string;
    badgeBgClass: string;
    frameBorderClass: string;
    glowBgStyle: string;
  }
> = {
  N: {
    badgeLabel: 'N • BRONZE',
    tierLabelJa: 'ブロンズ枠',
    badgeBgClass: 'bg-gradient-to-r from-[#FDBA74] to-[#C2410C] text-white',
    frameBorderClass: 'border-[#EA580C] bg-gradient-to-b from-[#431407] to-[#1E1B18]',
    glowBgStyle: 'radial-gradient(circle, rgba(251,146,60,0.45) 0%, rgba(255,255,255,0) 70%)',
  },
  R: {
    badgeLabel: 'R • SILVER',
    tierLabelJa: 'シルバー枠',
    badgeBgClass: 'bg-gradient-to-r from-[#F8FAFC] via-[#CBD5E1] to-[#64748B] text-[#1E1B18]',
    frameBorderClass: 'border-[#94A3B8] bg-gradient-to-b from-[#1E293B] to-[#0F172A]',
    glowBgStyle: 'radial-gradient(circle, rgba(148,163,184,0.5) 0%, rgba(255,255,255,0) 70%)',
  },
  SR: {
    badgeLabel: 'SR • GOLD',
    tierLabelJa: 'ゴールド枠',
    badgeBgClass: 'bg-gradient-to-r from-[#FEF08A] via-[#FFBE0B] to-[#D97706] text-[#1E1B18]',
    frameBorderClass: 'border-[#FFBE0B] bg-gradient-to-b from-[#451A03] to-[#1E1B18]',
    glowBgStyle: 'radial-gradient(circle, rgba(250,204,21,0.6) 0%, rgba(255,255,255,0) 70%)',
  },
  SSR: {
    badgeLabel: 'SSR • HOLOGRAM',
    tierLabelJa: 'ホログラム虹枠',
    badgeBgClass:
      'bg-gradient-to-r from-[#F472B6] via-[#FDE047] to-[#38BDF8] text-[#1E1B18] shadow-[0_0_12px_rgba(244,114,182,0.6)]',
    frameBorderClass:
      'border-[#F472B6] bg-gradient-to-br from-[#3B0764] via-[#1E1B4B] to-[#0F172A]',
    glowBgStyle:
      'radial-gradient(circle, rgba(244,114,182,0.62) 0%, rgba(56,189,248,0.38) 45%, rgba(255,255,255,0) 72%)',
  },
};

/**
 * 刻印テキストを埋め込んだフォールバック記念メダルSVG Data URLを生成する
 */
export function createFallbackMedalSvgDataUrl(
  rarity: MedalRarity,
  engravedText = 'TASK MASTER',
): string {
  const palette: Record<MedalRarity, { c1: string; c2: string; rim: string }> = {
    N: { c1: '#FDBA74', c2: '#9A3412', rim: '#F97316' },
    R: { c1: '#F8FAFC', c2: '#64748B', rim: '#CBD5E1' },
    SR: { c1: '#FEF08A', c2: '#B45309', rim: '#FFBE0B' },
    SSR: { c1: '#F472B6', c2: '#38BDF8', rim: '#FDE047' },
  };
  const { c1, c2, rim } = palette[rarity] ?? palette.N;
  const safeText = engravedText.replace(/[<>&"']/g, '').slice(0, 20);
  return buildFallbackSvgDataUrl(rarity, c1, c2, rim, safeText);
}
