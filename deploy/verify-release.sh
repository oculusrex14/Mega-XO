#!/usr/bin/env bash
set -euo pipefail

image=${1:?Usage: verify-release.sh ghcr.io/oculusrex14/mega-xo@sha256:DIGEST GIT_SHA [VERSION]}
sha=${2:?Expected 40-character Git SHA required}
version=${3:-}

[[ "$image" =~ ^ghcr\.io/oculusrex14/mega-xo@sha256:[a-f0-9]{64}$ ]] || { echo 'Use an immutable Mega XO GHCR digest.' >&2; exit 64; }
[[ "$sha" =~ ^[a-f0-9]{40}$ ]] || { echo 'Expected Git SHA must be 40 lowercase hex characters.' >&2; exit 64; }
[[ -z "$version" || "$version" =~ ^4\.[0-9]+\.[0-9]+$ ]] || { echo 'Expected version must be a V4 semantic version.' >&2; exit 64; }

docker pull "$image" >/dev/null

revision=$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
[[ "$revision" = "$sha" ]] || { echo "Image revision mismatch: expected $sha, got $revision" >&2; exit 65; }

repo_digests=$(docker image inspect "$image" --format '{{json .RepoDigests}}')
digest=${image#*@}
grep -q "$digest" <<<"$repo_digests" || { echo 'Pulled image does not report the requested immutable digest.' >&2; exit 65; }

runtime_sha=$(docker run --rm --entrypoint node "$image" -e 'process.stdout.write(process.env.MEGA_RELEASE||"")')
[[ "$runtime_sha" = "$sha" ]] || { echo 'Runtime MEGA_RELEASE does not match the release Git SHA.' >&2; exit 65; }

if [[ -n "$version" ]]; then
  runtime_version=$(docker run --rm --entrypoint node "$image" -e 'process.stdout.write(require("/app/package.json").version)')
  [[ "$runtime_version" = "$version" ]] || { echo "Image version mismatch: expected $version, got $runtime_version" >&2; exit 65; }
fi

host_arch=$(uname -m)
image_arch=$(docker image inspect "$image" --format '{{.Architecture}}')
case "$host_arch:$image_arch" in
  aarch64:arm64|arm64:arm64|x86_64:amd64|amd64:amd64) ;;
  *) echo "Image architecture $image_arch does not match host $host_arch." >&2; exit 65 ;;
esac

echo "Immutable release verified: $image -> $sha${version:+ (v$version)}"
