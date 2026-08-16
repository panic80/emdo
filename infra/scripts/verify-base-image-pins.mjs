#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { URL } from 'node:url';

const registryFetch = globalThis.fetch;
if (typeof registryFetch !== 'function') {
  throw new Error('Node.js fetch support is required');
}

const dockerfile = await readFile(
  new URL('../../Dockerfile', import.meta.url),
  'utf8',
);

const pins = [
  {
    repository: 'library/node',
    tag: '24.13.0-bookworm-slim',
    digest:
      'sha256:4660b1ca8b28d6d1906fd644abe34b2ed81d15434d26d845ef0aced307cf4b6f',
    occurrences: 3,
  },
  {
    repository: 'nginxinc/nginx-unprivileged',
    tag: '1.29.1-alpine',
    digest:
      'sha256:27985295bdb22a1ef8f712863210bd5877c0f3006494a593e86b3fe0fa55467e',
    occurrences: 1,
  },
];

const acceptedIndexes = new Set([
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
]);

for (const pin of pins) {
  const tokenResponse = await registryFetch(
    `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${pin.repository}:pull`,
  );
  if (!tokenResponse.ok) {
    throw new Error(
      `Docker Hub token request failed for ${pin.repository}: ${tokenResponse.status}`,
    );
  }
  const tokenPayload = await tokenResponse.json();
  if (typeof tokenPayload.token !== 'string' || tokenPayload.token === '') {
    throw new Error(`Docker Hub returned no token for ${pin.repository}`);
  }

  const manifestResponse = await registryFetch(
    `https://registry-1.docker.io/v2/${pin.repository}/manifests/${pin.tag}`,
    {
      headers: {
        Accept: [
          'application/vnd.oci.image.index.v1+json',
          'application/vnd.docker.distribution.manifest.list.v2+json',
        ].join(', '),
        Authorization: `Bearer ${tokenPayload.token}`,
      },
    },
  );
  if (!manifestResponse.ok) {
    throw new Error(
      `Docker Hub manifest request failed for ${pin.repository}:${pin.tag}: ${manifestResponse.status}`,
    );
  }

  const manifest = await manifestResponse.json();
  if (!acceptedIndexes.has(manifest.mediaType)) {
    throw new Error(
      `${pin.repository}:${pin.tag} is not a manifest list/index (${String(manifest.mediaType)})`,
    );
  }
  const registryDigest = manifestResponse.headers.get('docker-content-digest');
  if (registryDigest !== pin.digest) {
    throw new Error(
      `${pin.repository}:${pin.tag} moved: expected ${pin.digest}, registry returned ${String(registryDigest)}`,
    );
  }

  const reference = `${pin.repository === 'library/node' ? 'node' : pin.repository}:${pin.tag}@${pin.digest}`;
  const count = dockerfile.split(reference).length - 1;
  if (count !== pin.occurrences) {
    throw new Error(
      `Dockerfile contains ${count} copies of ${reference}; expected ${pin.occurrences}`,
    );
  }

  process.stdout.write(
    `verified docker.io/${pin.repository}:${pin.tag}@${pin.digest} (${manifest.mediaType})\n`,
  );
}
