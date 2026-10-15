FROM node:22.23.3-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c

ENV KAB_STATE_DIR=/var/lib/agent-bridge
RUN mkdir -p /var/lib/agent-bridge && chown -R node:node /var/lib/agent-bridge
USER node
VOLUME ["/var/lib/agent-bridge"]

HEALTHCHECK --interval=1s --timeout=1s --start-period=1s --retries=2 \
  CMD ["node", "-e", "const fs=require('node:fs'); process.exit(fs.existsSync('/var/lib/agent-bridge/previous-runtime.marker') ? 0 : 1)"]

CMD ["node", "-e", "const fs=require('node:fs'); fs.mkdirSync('/var/lib/agent-bridge',{recursive:true}); fs.writeFileSync('/var/lib/agent-bridge/previous-runtime.marker','previous-runtime\\n'); setInterval(()=>{},1000)"]
