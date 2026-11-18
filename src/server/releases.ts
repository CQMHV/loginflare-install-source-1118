import manifest from '../../release.json';
import { newerVersion, stableVersion, updateRepository, updateWorkflow, upstreamRepository, type UpdateStatus } from '../shared/releases';
import type { Env } from './config';

const feed = `https://api.github.com/repos/${upstreamRepository}/releases/latest`;
const releasesPage = `https://github.com/${upstreamRepository}/releases`;
type Latest = { status: 'unpublished' | 'unavailable' } | { status: 'published'; version: string };

export function releaseFeed(request: typeof fetch = (...args) => fetch(...args), now = Date.now) {
    let cached: { latest: Latest; expiresAt: number } | undefined;
    return async (): Promise<Latest> => {
        if (cached && now() < cached.expiresAt) return cached.latest;
        let latest: Latest = { status: 'unavailable' };
        try {
            const response = await request(feed, {
                redirect: 'error', signal: AbortSignal.timeout(3000),
                headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Loginflare-release-check' },
            });
            if (response.status === 404) latest = { status: 'unpublished' };
            else if (response.ok) {
                // Bound response size without trusting Content-Length.
                const reader = response.body?.getReader();
                if (!reader) throw new Error('Missing release response');
                const decoder = new TextDecoder();
                let content = '', bytes = 0;
                try {
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        bytes += value.byteLength;
                        if (bytes > 262_144) throw new Error('Release response too large');
                        content += decoder.decode(value, { stream: true });
                    }
                } finally { await reader.cancel().catch(() => {}); }
                const release = JSON.parse(content + decoder.decode());
                const version = typeof release?.tag_name === 'string' && release.tag_name.startsWith('v') ? release.tag_name.slice(1) : null;
                if (stableVersion(version) && release.draft === false && release.prerelease === false && release.published_at) {
                    latest = { status: 'published', version };
                }
            }
        } catch { /* A release check must not make the console unavailable. */ }
        cached = { latest, expiresAt: now() + (latest.status === 'unavailable' ? 60_000 : 3_600_000) };
        return latest;
    };
}

const latestRelease = releaseFeed();

export async function readUpdateStatus(env: Env, check = latestRelease): Promise<UpdateStatus> {
    const currentVersion = stableVersion(env.LOGINFLARE_RELEASE_VERSION) ? env.LOGINFLARE_RELEASE_VERSION : manifest.version;
    const currentCommit = /^[a-f0-9]{40}$/.test(env.LOGINFLARE_SOURCE_COMMIT ?? '') ? env.LOGINFLARE_SOURCE_COMMIT! : null;
    const repository = updateRepository(env.LOGINFLARE_UPDATE_REPOSITORY);
    const latest: Latest = env.APP_ENV === 'development' ? { status: 'unpublished' } : await check();
    const available = latest.status === 'published' && newerVersion(latest.version, currentVersion);
    const availableVersion = available && latest.status === 'published' ? latest.version : null;
    return {
        currentVersion, currentCommit, availableVersion,
        status: available ? 'available' : latest.status === 'published' ? 'current' : latest.status,
        releaseUrl: availableVersion ? `${releasesPage}/tag/v${availableVersion}` : releasesPage,
        actionUrl: available && repository ? `https://github.com/${repository}/actions/workflows/${updateWorkflow}` : null,
    };
}
