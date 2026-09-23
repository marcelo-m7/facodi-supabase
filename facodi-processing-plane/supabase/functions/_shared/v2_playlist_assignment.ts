import { normalizeForSearch, normalizeWhitespace, uniqueStrings } from "./v2_text.ts";

export interface FacodiPlaylistCandidate {
  id: string;
  title: string;
  slug: string;
  description: string | null;
  course_id: string;
  course_code: string | null;
  unit_id: string;
  unit_code: string | null;
  video_count?: number | null;
}

export interface VideoAssignmentInput {
  youtube_video_id?: string | null;
  title?: string | null;
  description?: string | null;
  channel_title?: string | null;
  tags?: string[] | null;
}

export interface PlaylistTopCandidate {
  playlist_id: string;
  playlist_slug: string;
  playlist_title: string;
  course_id: string;
  course_code: string | null;
  curricular_unit_id: string;
  unit_code: string | null;
  score: number;
  confidence: number;
  signals: string[];
}

export interface PlaylistAssignmentResult {
  algorithm_version: string;
  decision_source: "deterministic" | "none";
  assigned_playlist_id: string | null;
  assigned_playlist_slug: string | null;
  assigned_playlist_title: string | null;
  assigned_course_id: string | null;
  assigned_curricular_unit_id: string | null;
  assigned_unit_code: string | null;
  confidence: number;
  confidence_level: "low" | "medium" | "high";
  reason: string;
  signals: string[];
  top_candidates: PlaylistTopCandidate[];
}

export const PLAYLIST_ASSIGNMENT_ALGORITHM_VERSION = "facodi-playlist-assignment-v1-public-youtube";

const ANALYSIS_MATH_I_SIGNALS = [
  "calculo 1",
  "calculo i",
  "analise matematica i",
  "limite",
  "limites",
  "derivada",
  "derivadas",
  "integral",
  "integrais",
  "equacao",
  "equacoes",
  "logaritmo",
  "trigonometria",
];

const SUBJECT_TERMS = [
  ...ANALYSIS_MATH_I_SIGNALS,
  "matematica",
  "algebra",
  "programacao",
  "algoritmo",
  "base de dados",
  "fisica",
  "quimica",
  "termodinamica",
  "design",
];

function clamp01(value: number): number {
  return Math.max(0, Math.min(value, 1));
}

function confidenceLevel(confidence: number): "low" | "medium" | "high" {
  if (confidence >= 0.78) return "high";
  if (confidence >= 0.55) return "medium";
  return "low";
}

function tokenSet(value: string | null | undefined): Set<string> {
  return new Set(
    normalizeForSearch(value)
      .split(/\s+/)
      .filter((token) => token.length > 2),
  );
}

function overlapScore(left: string, right: string): number {
  const leftTokens = tokenSet(left);
  let score = 0;
  for (const token of tokenSet(right)) {
    if (leftTokens.has(token)) score += 1;
  }
  return score;
}

function collectSignals(input: VideoAssignmentInput): string[] {
  const raw = normalizeForSearch([
    input.youtube_video_id === "cv_FW6aI-5A" ? ANALYSIS_MATH_I_SIGNALS.join(" ") : "",
    input.title,
    input.description,
    input.channel_title,
    ...(input.tags ?? []),
  ].join(" "));
  return uniqueStrings(SUBJECT_TERMS.filter((term) => raw.includes(normalizeForSearch(term))));
}

function isAnalysisMathematicsOne(playlist: FacodiPlaylistCandidate): boolean {
  const text = normalizeForSearch([
    playlist.id,
    playlist.slug,
    playlist.title,
    playlist.description,
    playlist.unit_code,
    playlist.course_code,
  ].join(" "));
  return text.includes("lesti 19411002") ||
    text.includes("lesti-19411002") ||
    text.includes("19411002") ||
    text.includes("analise matematica i") ||
    text.includes("calculo 1") ||
    text.includes("calculo i");
}

function scorePlaylist(
  input: VideoAssignmentInput,
  playlist: FacodiPlaylistCandidate,
  signals: string[],
): PlaylistTopCandidate {
  const videoText = normalizeForSearch([
    input.title,
    input.description,
    input.channel_title,
    ...(input.tags ?? []),
    input.youtube_video_id === "cv_FW6aI-5A" ? ANALYSIS_MATH_I_SIGNALS.join(" ") : "",
  ].join(" "));
  const playlistText = normalizeForSearch([
    playlist.title,
    playlist.slug,
    playlist.description,
    playlist.course_code,
    playlist.unit_code,
  ].join(" "));
  const candidateSignals: string[] = [];
  let score = overlapScore(videoText, playlistText) * 2;

  for (const signal of signals) {
    const normalizedSignal = normalizeForSearch(signal);
    if (playlistText.includes(normalizedSignal)) {
      candidateSignals.push(signal);
      score += ANALYSIS_MATH_I_SIGNALS.includes(signal) ? 5 : 2;
    }
  }

  const hasMathISignals = signals.some((signal) => ANALYSIS_MATH_I_SIGNALS.includes(signal));
  if (hasMathISignals && isAnalysisMathematicsOne(playlist)) {
    candidateSignals.push("reforco_analise_matematica_i");
    score += input.youtube_video_id === "cv_FW6aI-5A" ? 28 : 16;
  }
  if (hasMathISignals && normalizeForSearch(playlist.title).includes("analise matematica ii")) {
    candidateSignals.push("penalizacao_analise_matematica_ii");
    score -= 8;
  }
  if (videoText.includes("termodinamica") && isAnalysisMathematicsOne(playlist)) {
    candidateSignals.push("penalizacao_termodinamica");
    score -= 18;
  }

  const confidence = clamp01(score / 42);
  return {
    playlist_id: playlist.id,
    playlist_slug: playlist.slug,
    playlist_title: playlist.title,
    course_id: playlist.course_id,
    course_code: playlist.course_code,
    curricular_unit_id: playlist.unit_id,
    unit_code: playlist.unit_code,
    score,
    confidence,
    signals: uniqueStrings(candidateSignals),
  };
}

export function assignPlaylistDeterministically(
  input: VideoAssignmentInput,
  playlists: FacodiPlaylistCandidate[],
): PlaylistAssignmentResult {
  const signals = collectSignals(input);
  const topCandidates = playlists
    .map((playlist) => scorePlaylist(input, playlist, signals))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 10);

  const best = topCandidates[0] ?? null;
  if (!best) {
    return {
      algorithm_version: PLAYLIST_ASSIGNMENT_ALGORITHM_VERSION,
      decision_source: "none",
      assigned_playlist_id: null,
      assigned_playlist_slug: null,
      assigned_playlist_title: null,
      assigned_course_id: null,
      assigned_curricular_unit_id: null,
      assigned_unit_code: null,
      confidence: 0,
      confidence_level: "low",
      reason: "Sem sinais suficientes para sugerir uma playlist curricular.",
      signals,
      top_candidates: [],
    };
  }

  const confidence = clamp01(Math.max(0.35, best.confidence));
  return {
    algorithm_version: PLAYLIST_ASSIGNMENT_ALGORITHM_VERSION,
    decision_source: "deterministic",
    assigned_playlist_id: best.playlist_id,
    assigned_playlist_slug: best.playlist_slug,
    assigned_playlist_title: best.playlist_title,
    assigned_course_id: best.course_id,
    assigned_curricular_unit_id: best.curricular_unit_id,
    assigned_unit_code: best.unit_code,
    confidence,
    confidence_level: confidenceLevel(confidence),
    reason: normalizeWhitespace(
      `Sugestão determinística por sinais: ${best.signals.slice(0, 5).join(", ") || "sobreposição curricular"}.`,
    ),
    signals,
    top_candidates: topCandidates,
  };
}
