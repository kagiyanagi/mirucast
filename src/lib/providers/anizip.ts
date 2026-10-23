import { unstable_cache } from "next/cache";

import {
  describeError,
  fetchJson,
  ProviderFetchError,
} from "@/lib/http/client";
import type { AnimeStreamingEpisode } from "@/types/anime";

const ANIZIP_ENDPOINT = "https://api.ani.zip/mappings";

export type AnimeIdMappings = {
  anilistId: number;
  malId: number | null;
  kitsuId: number | null;
  anidbId: number | null;
  thetvdbId: number | null;
  themoviedbId: number | null;
  imdbId: string | null;
  animePlanetId: string | null;
  livechartId: number | null;
  type: string | null;
};

export type AniZipArtwork = {
  coverType: string;
  url: string;
};

export type AniZipData = {
  mappings: AnimeIdMappings;
  episodes: AnimeStreamingEpisode[];
  episodeCount: number | null;
  specialCount: number | null;
  images: AniZipArtwork[];
  /** Share (0..1) of numbered episodes that have a real thumbnail. */
  imageCoverage: number;
};

type AniZipRawEpisode = {
  tvdbShowId?: number;
  tvdbId?: number;
  title?: {
    en?: string;
    "x-jat"?: string;
    ja?: string;
  };
  overview?: string;
  summary?: string;
  image?: string;
  airdate?: string;
  airDate?: string;
  airDateUtc?: string;
  runtime?: number;
  rating?: string;
};

type AniZipResponse = {
  episodes?: Record<string, AniZipRawEpisode>;
  episodeCount?: number;
  specialCount?: number;
  images?: Array<{ coverType?: string; url?: string }>;
  mappings?: {
    mal_id?: number;
    kitsu_id?: number;
    anidb_id?: number;
    thetvdb_id?: number;
    themoviedb_id?: number | string;
    imdb_id?: string;
    animeplanet_id?: string;
    livechart_id?: number;
    type?: string;
  };
};

function toNumericId(value: unknown): number | null {
  const parsed =
    typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function toStringId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getTvdbEpisodeImage(showId: number, episodeId: number): string {
  return `https://artworks.thetvdb.com/banners/episodes/${showId}/${episodeId}.jpg`;
}

function toMappings(
  anilistId: number,
  raw: AniZipResponse["mappings"],
): AnimeIdMappings {
  return {
    anilistId,
    malId: toNumericId(raw?.mal_id),
    kitsuId: toNumericId(raw?.kitsu_id),
    anidbId: toNumericId(raw?.anidb_id),
    thetvdbId: toNumericId(raw?.thetvdb_id),
    themoviedbId: toNumericId(raw?.themoviedb_id),
    imdbId: toStringId(raw?.imdb_id),
    animePlanetId: toStringId(raw?.animeplanet_id),
    livechartId: toNumericId(raw?.livechart_id),
    type: toStringId(raw?.type),
  };
}

function toEpisodes(
  rawEpisodes: Record<string, AniZipRawEpisode>,
): AnimeStreamingEpisode[] {
  return Object.keys(rawEpisodes)
    .filter((key) => !isNaN(Number(key))) // Ensure we only get numbered episodes
    .sort((a, b) => Number(a) - Number(b))
    .map((key) => {
      const number = Number(key);
      const ep = rawEpisodes[key];
      // Priority for title: English -> Japanese (Romaji) -> Fallback
      const title = ep.title?.en || ep.title?.["x-jat"] || ep.title?.ja || null;
      // Only use TVDB image URLs that ani.zip explicitly provides IDs for.
      // Inferring URLs by incrementing TVDB episode IDs produces 404s because
      // those IDs are not sequential.
      const explicitTvdbImage =
        ep.tvdbShowId && ep.tvdbId
          ? getTvdbEpisodeImage(ep.tvdbShowId, ep.tvdbId)
          : null;

      const ratingValue = Number.parseFloat(ep.rating || "");

      return {
        number,
        title,
        thumbnail: ep.image || explicitTvdbImage,
        description: ep.overview || ep.summary || null,
        url: null,
        site: "TVDB",
        airDate:
          ep.airdate || ep.airDate || ep.airDateUtc?.slice(0, 10) || null,
        airDateTime: ep.airDateUtc || null,
        rating:
          Number.isFinite(ratingValue) && ratingValue > 0
            ? Math.round(ratingValue * 10) / 10
            : null,
      };
    });
}

function toAniZipData(anilistId: number, data: AniZipResponse): AniZipData {
  const episodes = toEpisodes(data.episodes || {});
  const withThumbnail = episodes.filter((episode) => episode.thumbnail);

  return {
    mappings: toMappings(anilistId, data.mappings),
    episodes,
    episodeCount: toNumericId(data.episodeCount),
    specialCount: toNumericId(data.specialCount),
    images:
      data.images?.flatMap((image) =>
        image.url
          ? [{ coverType: image.coverType || "Unknown", url: image.url }]
          : [],
      ) || [],
    imageCoverage: episodes.length
      ? withThumbnail.length / episodes.length
      : 0,
  };
}

/**
 * Fetches and parses one ani.zip entry. Throws ProviderFetchError on any
 * failure (including an empty or malformed body) so a failure is never
 * stored in the data cache below.
 */
async function loadAniZipData(anilistId: number): Promise<AniZipData> {
  const data = await fetchJson<AniZipResponse>(
    `${ANIZIP_ENDPOINT}?anilist_id=${anilistId}`,
    {
      // Ignored inside unstable_cache (fetches there are never cached); only
      // applies on the uncached fallback path in getAniZipData.
      next: { revalidate: 86400 },
    },
    {
      provider: "AniZip",
      timeoutMs: 6_000,
      retries: 1,
      retryDelayMs: 500,
      cacheKey: `anizip:${anilistId}`,
      staleTtlMs: 86400 * 1000 * 7,
    },
  );

  try {
    if (!data || typeof data !== "object") {
      throw new Error("empty response body");
    }

    return toAniZipData(anilistId, data);
  } catch (error) {
    throw new ProviderFetchError({
      provider: "AniZip",
      message: `AniZip response for ${anilistId} could not be parsed: ${describeError(error)}`,
      cause: error,
    });
  }
}

// Long-running shows (One Piece, Conan) return 1.5-2.5MB of raw JSON, over
// the 2MB per-entry limit of Next's fetch cache, so caching the raw fetch
// silently failed and refetched on every request. The parsed result is less
// than half the size, so cache that instead.
const getCachedAniZipData = unstable_cache(loadAniZipData, ["anizip-data-v1"], {
  revalidate: 86400,
});

async function getAniZipDataWithCacheFallback(
  anilistId: number,
): Promise<AniZipData> {
  try {
    return await getCachedAniZipData(anilistId);
  } catch (error) {
    if (error instanceof ProviderFetchError) {
      throw error;
    }

    // Next's cache layer itself failed (not ani.zip) - the data matters more
    // than caching it, so load it directly.
    console.warn(
      `AniZip data cache unavailable for ${anilistId}, loading uncached: ${describeError(error)}`,
    );
    return loadAniZipData(anilistId);
  }
}

export async function getAniZipData(
  anilistId: number,
): Promise<AniZipData | null> {
  if (!Number.isInteger(anilistId) || anilistId <= 0) {
    return null;
  }

  try {
    return await getAniZipDataWithCacheFallback(anilistId);
  } catch (error) {
    if (error instanceof ProviderFetchError && error.status === 404) {
      // ani.zip simply has no entry for this title - expected, not an error.
      return null;
    }

    console.warn(`AniZip fetch failed for ${anilistId}: ${describeError(error)}`);
    return null;
  }
}

export async function getAniZipEpisodes(
  anilistId: number,
): Promise<AnimeStreamingEpisode[]> {
  const data = await getAniZipData(anilistId);
  return data?.episodes || [];
}

export async function getAnimeMappings(
  anilistId: number,
): Promise<AnimeIdMappings | null> {
  const data = await getAniZipData(anilistId);
  return data?.mappings || null;
}

// Wide artwork that works as a hero backdrop, best first. Fanart is 16:9
// background art; the TVDB "Banner" is thin but still wide. Portrait posters
// are intentionally excluded - they do not work as a banner.
const BANNER_COVER_PRIORITY = ["fanart", "banner"];

/**
 * Picks the best wide artwork from ani.zip's image set to use as a banner when
 * AniList has none. Returns null when only portrait artwork is available.
 */
export function pickAniZipBanner(images: AniZipArtwork[]): string | null {
  for (const coverType of BANNER_COVER_PRIORITY) {
    const match = images.find(
      (image) => image.url && image.coverType.toLowerCase() === coverType,
    );
    if (match) return match.url;
  }
  return null;
}
