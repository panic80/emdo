# Dedicated runtime artifact must be built on the target Linux architecture.
# It contains only bundled renderer code and pinned PDF.js/canvas dependencies.
FROM node:24.13.0-bookworm-slim@sha256:4660b1ca8b28d6d1906fd644abe34b2ed81d15434d26d845ef0aced307cf4b6f
COPY --chown=10005:10005 runtime/ /opt/emdo/pdf-render/
RUN ln -s /opt/emdo/pdf-render/helper.js /usr/local/bin/emdo-finance-pdf-render-helper \
    && mkdir -p /run/emdo/finance-pdf-render \
    && chown 10005:10005 /run/emdo/finance-pdf-render \
    && chmod 0770 /run/emdo/finance-pdf-render
USER 10005:10005
WORKDIR /tmp
ENTRYPOINT ["/usr/local/bin/node", "/opt/emdo/pdf-render/socket-server.js"]
