# Audio tools for the shouts (tools/audio/make-shouts.sh): espeak-ng, SoX and opus-tools on the
# same Node base as the dev image, so the download is only these Debian packages and their libraries.
FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
RUN apt-get update \
 && apt-get install -y --no-install-recommends espeak-ng sox opus-tools \
 && rm -rf /var/lib/apt/lists/* \
 && dpkg-query -W -f '${Package} ${Version}\n' espeak-ng espeak-ng-data libespeak-ng1 sox libsox3 opus-tools libopus0 > /opt/audio-packages.txt
