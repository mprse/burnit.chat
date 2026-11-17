const IS_BURNIT_PRODUCTION = ['burnit.chat', 'www.burnit.chat'].includes(location.hostname);
const LOCAL_APPLICATION_URL = new URL('./', location.href).href;

window.SAFECHAT_CONFIG = Object.freeze({
    publicBaseUrl: IS_BURNIT_PRODUCTION
        ? 'https://burnit.chat/'
        : LOCAL_APPLICATION_URL,
    websocketUrl: IS_BURNIT_PRODUCTION
        ? `wss://${location.host}/ws/`
        : 'ws://localhost:8080/ws',
    debug: !IS_BURNIT_PRODUCTION
});
