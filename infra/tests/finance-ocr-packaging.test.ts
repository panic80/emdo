import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

const readRepositoryFile = (relativePath: string): Promise<string> =>
  readFile(`${repositoryRoot}/${relativePath}`, 'utf8');

describe('Finance OCR release package', () => {
  it('keeps the native runtime package pinned and reproducible', async () => {
    const [
      dockerfile,
      installer,
      policy,
      healthcheck,
      wrapper,
      helper,
      dockerignore,
    ] = await Promise.all([
      readRepositoryFile('Dockerfile'),
      readRepositoryFile('infra/finance-ocr/install-runtime.sh'),
      readRepositoryFile('infra/finance-ocr/ImageMagick-policy.xml'),
      readRepositoryFile('infra/finance-ocr/runtime-healthcheck.sh'),
      readRepositoryFile('infra/finance-ocr/magick'),
      readRepositoryFile('infra/finance-ocr/helper-stdio.sh'),
      readRepositoryFile('.dockerignore'),
    ]);

    expect(dockerignore).toContain('!infra/finance-ocr/**');
    expect(dockerfile).toContain(
      'FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171 AS finance-ocr',
    );
    expect(
      dockerfile.match(/COPY infra\/finance-ocr \/opt\/emdo\/finance-ocr/g),
    ).toHaveLength(2);
    expect(
      dockerfile.match(/install-runtime\.sh \/opt\/emdo\/finance-ocr/g),
    ).toHaveLength(2);
    expect(dockerfile).toContain(
      'EMDO_FINANCE_IMAGE_OCR_MANIFEST=/usr/local/share/emdo/finance-ocr-runtime.json',
    );
    expect(dockerfile).toContain('USER 10003:10004');
    expect(dockerfile).toContain(
      'ENTRYPOINT ["/usr/local/bin/node", "/usr/local/lib/emdo-ocr-socket-server.mjs"]',
    );
    const helperStart = dockerfile.indexOf(' AS finance-ocr');
    const webStart = dockerfile.indexOf(' AS web');
    expect(helperStart).toBeGreaterThan(0);
    expect(webStart).toBeGreaterThan(helperStart);
    const helperTarget = dockerfile.slice(helperStart, webStart);
    expect(helperTarget).not.toContain('COPY --from=build');
    expect(helperTarget).toContain('COPY --from=finance-ocr-node /usr/local/bin/node /usr/local/bin/node');
    expect(helperTarget).not.toMatch(
      /(?:DATABASE_URL|API_KEY|AUTH_SECRET|SESSION_SECRET|OPENAI_API_KEY)/u,
    );

    expect(installer).toContain(
      "IMAGEMAGICK_VERSION='8:6.9.11.60+dfsg-1.6+deb12u13'",
    );
    expect(installer).toContain("TESSERACT_VERSION='5.3.0-2'");
    expect(installer).toContain("TESSERACT_LANG_VERSION='1:4.1.0-2'");
    expect(installer).toMatch(/CONVERT_BINARY_SHA256='[a-f0-9]{64}'/);
    expect(installer).toMatch(/IDENTIFY_BINARY_SHA256='[a-f0-9]{64}'/);
    expect(installer).toMatch(/ENG_TRAINEDDATA_SHA256='[a-f0-9]{64}'/);
    expect(installer).toMatch(/FRA_TRAINEDDATA_SHA256='[a-f0-9]{64}'/);
    expect(installer).toContain(
      'apt-get install --yes --no-install-recommends',
    );
    expect(installer).toContain('dpkg-query -W -f=');
    expect(installer).toContain('finance-ocr-runtime.json');
    expect(installer).toContain('finance-ocr-runtime.sha256');
    expect(installer).toContain('finance-ocr-policy.sha256');
    expect(installer).toContain('helper-stdio.sh');
    expect(installer).toContain('emdo-finance-ocr-helper');

    expect(policy).toContain('name="memory" value="128MiB"');
    expect(policy).toContain('name="map" value="128MiB"');
    expect(policy).toContain('name="disk" value="128MiB"');
    expect(policy).toContain('name="area" value="16MP"');
    expect(policy).toContain('name="width" value="8192"');
    expect(policy).toContain('name="height" value="8192"');
    expect(policy).toContain('name="thread" value="1"');
    expect(policy).toContain('name="time" value="15"');
    expect(policy).toContain('domain="delegate" rights="none" pattern="*"');
    expect(policy).toContain('domain="filter" rights="none" pattern="*"');
    expect(policy).toContain('domain="coder" rights="none" pattern="*"');
    expect(policy).toContain('pattern="{PNG,JPEG,WEBP}"');
    expect(policy).toContain('pattern="{PNM,PGM}"');
    expect(policy).toContain('pattern="@*"');
    expect(policy).toContain('pattern="/tmp/*"');
    expect(policy).not.toContain('domain="module"');
    expect(policy).not.toContain('pattern="{PDF,');
    expect(policy).not.toContain('pattern="{SVG,');

    expect(healthcheck).toContain('sha256sum --strict -c');
    expect(healthcheck).toContain('test "$version" = "5.3.0"');
    expect(healthcheck).toContain("printf 'P2\\n1 1\\n255\\n0\\n'");
    expect(healthcheck).toContain("'%PDF-1.4'");
    expect(wrapper).toContain('exec /usr/bin/identify-im6.q16');
    expect(wrapper).toContain('exec /usr/bin/convert-im6.q16');
    expect(wrapper).not.toContain('eval');
    expect(wrapper).not.toContain('sh -c');
    expect(helper).toContain('EMDO-FINANCE-OCR-HELPER-V1');
    expect(helper).toContain('source-sha256');
    expect(helper).toContain('sha256sum');
    expect(helper).toContain('emdo-finance-ocr-runtime-healthcheck');
    expect(helper).not.toContain('eval');
    expect(helper).not.toContain('docker.sock');
    expect(helper).not.toContain('curl ');

    await Promise.all(
      [
        'infra/finance-ocr/install-runtime.sh',
        'infra/finance-ocr/runtime-healthcheck.sh',
        'infra/finance-ocr/magick',
        'infra/finance-ocr/helper-stdio.sh',
      ].map((path) => access(`${repositoryRoot}/${path}`, constants.X_OK)),
    );
  });

  it('documents the no-egress and bounded resource contract for the helper image', async () => {
    const [readme, compose] = await Promise.all([
      readRepositoryFile('infra/finance-ocr/README.md'),
      readRepositoryFile('infra/compose/compose.finance-ocr.yml'),
    ]);

    expect(readme).toContain('--network none');
    expect(readme).toContain('--read-only');
    expect(readme).toContain('--cap-drop ALL');
    expect(readme).toContain('--security-opt no-new-privileges:true');
    expect(readme).toContain('--pids-limit 32');
    expect(readme).toContain('--memory 128m');
    expect(readme).toContain('--cpus 1');
    expect(readme).toContain(
      '--tmpfs /tmp:size=64m,noexec,nosuid,nodev,mode=0700',
    );
    expect(readme).toContain('native-stdin-v1');
    expect(readme).toContain('database client');
    expect(readme).toContain("worker's direct local adapter path");

    expect(compose).toContain("image: '${FINANCE_OCR_IMAGE:?");
    expect(compose).toContain('profiles: [finance-ocr]');
    expect(compose).toContain('network_mode: none');
    expect(compose).toContain('read_only: true');
    expect(compose).toContain('cap_drop:');
    expect(compose).toContain('no-new-privileges:true');
    expect(compose).toContain('/tmp:size=64m,noexec,nosuid,nodev,mode=0700');
    expect(compose).toContain('memory: 128M');
    expect(compose).toContain("cpus: '1.0'");
    expect(compose).toContain('pids_limit: 32');
    expect(compose).not.toContain('env_file:');
    expect(compose).not.toContain('secrets:');
  });
});
