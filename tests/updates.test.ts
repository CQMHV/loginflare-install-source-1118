import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { readUpdateStatus, releaseFeed } from '../src/server/releases';
import { harness } from './helpers';

const release = { tag_name: 'v0.1.1', draft: false, prerelease: false, published_at: '2026-01-01T00:00:00Z' };

afterEach(async () => { vi.unstubAllGlobals(); await reset(); });

it('only administrators can read update status through the account service', async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        expect(String(input)).toContain('challenges.cloudflare.com/turnstile/v0/siteverify');
        return Response.json({ success: true });
    }));
    const client = harness();
    const path = '/api/admin/updates';
    expect((await client.request(path)).status).toBe(401);
    await client.verify();
    expect((await client.request(path, { cookie: await client.signin() })).status).toBe(403);
    const cookie = await client.administrator();
    const response = await client.request(path, { cookie });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ currentVersion: '0.1.0', status: 'unpublished', actionUrl: null });
    expect((await client.request(path, { cookie, method: 'POST' })).status).toBe(405);
});

it('reports a stable update, caches the public feed, and leaves repository writes to GitHub', async () => {
    let time = 0;
    const request = vi.fn<typeof fetch>(async (url, init) => {
        expect(url).toBe('https://api.github.com/repos/CQMHV/loginflare/releases/latest');
        expect(init?.redirect).toBe('error');
        expect(new Headers(init?.headers).has('Authorization')).toBe(false);
        return Response.json(release);
    });
    const check = releaseFeed(request, () => time);
    const deployment = { ...harness().bindings, APP_ENV: 'production' as const, LOGINFLARE_RELEASE_VERSION: '0.1.0',
        LOGINFLARE_SOURCE_COMMIT: '1'.repeat(40), LOGINFLARE_UPDATE_REPOSITORY: 'example/installation' };
    expect(await readUpdateStatus(deployment, check)).toMatchObject({ status: 'available', availableVersion: '0.1.1',
        releaseUrl: 'https://github.com/CQMHV/loginflare/releases/tag/v0.1.1',
        actionUrl: 'https://github.com/example/installation/actions/workflows/prepare-update.yml' });
    expect(await readUpdateStatus({ ...deployment, LOGINFLARE_RELEASE_VERSION: '0.1.1' }, check)).toMatchObject({ status: 'current', actionUrl: null });
    expect(await readUpdateStatus({ ...deployment, LOGINFLARE_UPDATE_REPOSITORY: 'https://example.test/test' }, check)).toMatchObject({ status: 'available', actionUrl: null });
    expect(request).toHaveBeenCalledTimes(1);
    time = 3_600_000;
    await check();
    expect(request).toHaveBeenCalledTimes(2);
});

it('distinguishes no releases from transient errors and ignores drafts and prereleases', async () => {
    expect(await releaseFeed(async () => new Response(null, { status: 404 }))()).toEqual({ status: 'unpublished' });
    for (const candidate of [{ ...release, draft: true }, { ...release, tag_name: 'v0.1.2-beta.1' }]) {
        expect(await releaseFeed(async () => Response.json(candidate))()).toEqual({ status: 'unavailable' });
    }
    expect(await releaseFeed(async () => new Response(null, { status: 429 }))()).toEqual({ status: 'unavailable' });
});
