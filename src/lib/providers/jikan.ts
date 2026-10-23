import {
  describeError,
  fetchJson,
  ProviderFetchError,
  type ProviderBreakerOptions,
} from "@/lib/http/client";
import type {
  AnimeNewsArticle,
  EpisodeFlags,
  MalStats,
  ProviderHealth,
} from "@/types/anime";

// Jikan is a free, keyless REST mirror of MyAnimeList data.
// Public rate limit is 60 requests/minute - long revalidation keeps us
// far below it.
const JIKAN_ENDPOINT = "https://api.jikan.moe/v4";

// Jikan goes unresponsive for long stretches. Once it has failed a few times
// in a row, stop making every page wait out the full timeout for optional
// enrichment - see ProviderBreakerOptions.
const JIKAN_BREAKER: ProviderBreakerOptions = {
  threshold: 3,
  cooldownMs: 120_000,
  degradedTimeoutMs: 1_500,
};

function logJikanFailure(what: string, malId: number, error: unknown) {
  // The outage itself is already logged once by the breaker.
  if (error instanceof ProviderFetchError && error.duringOutage) {
    return;
  }

  console.warn(
    `Jikan ${what} fetch failed for MAL ${malId}: ${describeError(error)}`,
  );
}

type JikanAnimeResponse = {
  data?: {
    mal_id?: number;
    url?: string;
    score?: number | null;
    scored_by?: number | null;
    rank?: number | null;
    popularity?: number | null;
    members?: number | null;
    favorites?: number | null;
  };
};

export function getJikanProviderHealth(): ProviderHealth {
  return {
    name: "Jikan (MyAnimeList)",
    role: "metadata",
    status: "ready",
    notes: "MyAnimeList ratings for cross-platform score comparison.",
  };
}

function toCount(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

export async function getMalStats(malId: number): Promise<MalStats | null> {
  try {
    const payload = await fetchJson<JikanAnimeResponse>(
      `${JIKAN_ENDPOINT}/anime/${malId}`,
      {
        next: { revalidate: 21_600 },
      },
      {
        provider: "Jikan",
        // Jikan is heavily rate-limited and this is optional enrichment behind
        // a soft timeout - fail fast instead of burning a retry delay (~1s) on
        // a 429/down response.
        timeoutMs: 4_000,
        retries: 0,
        breaker: JIKAN_BREAKER,
        retryDelayMs: 1_000,
        cacheKey: `jikan:anime:${malId}`,
        staleTtlMs: 21_600 * 1000 * 8,
      },
    );

    if (!payload?.data?.mal_id) {
      return null;
    }

    const rawScore = payload.data.score;

    return {
      malId: payload.data.mal_id,
      score:
        typeof rawScore === "number" && rawScore > 0
          ? Math.round(rawScore * 10)
          : null,
      scoredBy: toCount(payload.data.scored_by),
      rank: toCount(payload.data.rank),
      popularity: toCount(payload.data.popularity),
      members: toCount(payload.data.members),
      favorites: toCount(payload.data.favorites),
      url: payload.data.url || `https://myanimelist.net/anime/${malId}`,
    };
  } catch (error) {
    logJikanFailure("stats", malId, error);
    return null;
  }
}

type JikanEpisodesResponse = {
  data?: Array<{
    mal_id?: number;
    filler?: boolean;
    recap?: boolean;
  }>;
  pagination?: {
    last_visible_page?: number;
    has_next_page?: boolean;
  };
};

// 100 episodes per Jikan page; 15 pages covers 1500 episodes (One Piece
// territory) without hammering the API for outliers.
const MAX_EPISODE_PAGES = 15;

async function fetchEpisodePage(
  malId: number,
  page: number,
): Promise<JikanEpisodesResponse | null> {
  return fetchJson<JikanEpisodesResponse>(
    `${JIKAN_ENDPOINT}/anime/${malId}/episodes?page=${page}`,
    {
      next: { revalidate: 86_400 },
    },
    {
      provider: "Jikan",
      timeoutMs: 6_000,
      retries: 1,
      breaker: JIKAN_BREAKER,
      retryDelayMs: 1_000,
      cacheKey: `jikan:episodes:${malId}:${page}`,
      staleTtlMs: 86_400 * 1000 * 7,
    },
  );
}

/**
 * Filler/recap episode numbers from MAL via Jikan. Returns null when the
 * lookup fails or MAL has no episode list - absence of data is never
 * presented as "not filler".
 */
export async function getJikanEpisodeFlags(
  malId: number,
): Promise<EpisodeFlags | null> {
  try {
    const firstPage = await fetchEpisodePage(malId, 1);

    if (!firstPage?.data?.length) {
      return null;
    }

    const lastPage = Math.min(
      firstPage.pagination?.last_visible_page || 1,
      MAX_EPISODE_PAGES,
    );
    // Jikan allows ~3 req/s - batch instead of bursting every page at once,
    // otherwise long shows trigger a 429/retry storm.
    const remainingPages: Array<JikanEpisodesResponse | null> = [];

    for (let page = 2; page <= lastPage; page += 3) {
      const batch = await Promise.all(
        Array.from(
          { length: Math.min(3, lastPage - page + 1) },
          (_, index) =>
            fetchEpisodePage(malId, page + index).catch(() => null),
        ),
      );
      remainingPages.push(...batch);
    }

    const filler: number[] = [];
    const recap: number[] = [];

    for (const pagePayload of [firstPage, ...remainingPages]) {
      for (const episode of pagePayload?.data || []) {
        if (!episode.mal_id) {
          continue;
        }

        if (episode.filler) {
          filler.push(episode.mal_id);
        }

        if (episode.recap) {
          recap.push(episode.mal_id);
        }
      }
    }

    return { filler, recap };
  } catch (error) {
    logJikanFailure("episode flags", malId, error);
    return null;
  }
}

type JikanNewsResponse = {
  data?: Array<{
    mal_id?: number;
    url?: string;
    title?: string;
    date?: string;
    author_username?: string;
    author_url?: string;
    forum_url?: string;
    images?: { jpg?: { image_url?: string | null } | null } | null;
    comments?: number | null;
    excerpt?: string | null;
  }>;
};

// MAL news entries carry an outro line ("Source: ...") and trailing ellipsis;
// keep the excerpt tidy without inventing content beyond what MAL published.
function cleanExcerpt(value: string | null | undefined): string | null {
  const trimmed = (value || "").replace(/\s+/g, " ").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Recent news articles for an anime from MyAnimeList via Jikan, newest first.
 * Returns an empty list when MAL has no news or the lookup fails - absence of
 * data is never presented as anything but "no news".
 */
export async function getAnimeNews(
  malId: number,
  limit = 12,
): Promise<AnimeNewsArticle[]> {
  try {
    const payload = await fetchJson<JikanNewsResponse>(
      `${JIKAN_ENDPOINT}/anime/${malId}/news`,
      {
        next: { revalidate: 10_800 },
      },
      {
        provider: "Jikan",
        // Optional enrichment behind a soft timeout on the route - fail fast
        // rather than burning a retry delay on a 429/down response.
        timeoutMs: 5_000,
        retries: 0,
        breaker: JIKAN_BREAKER,
        retryDelayMs: 1_000,
        cacheKey: `jikan:news:${malId}`,
        staleTtlMs: 10_800 * 1000 * 8,
      },
    );

    const items = payload?.data;

    if (!items?.length) {
      return [];
    }

    return items
      .filter((item) => item.mal_id && item.title && item.url && item.date)
      .slice(0, limit)
      .map((item) => ({
        id: item.mal_id!,
        title: item.title!,
        url: item.url!,
        date: item.date!,
        excerpt: cleanExcerpt(item.excerpt),
        imageUrl: item.images?.jpg?.image_url || null,
        author: item.author_username || null,
        authorUrl: item.author_url || null,
        forumUrl: item.forum_url || null,
        comments:
          typeof item.comments === "number" && item.comments >= 0
            ? item.comments
            : null,
      }));
  } catch (error) {
    logJikanFailure("news", malId, error);
    return [];
  }
}
