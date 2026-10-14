const SHINIGAMI_IMAGE_ACCEPT = "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";

const PROVIDER_REQUEST_HEADERS = Object.freeze({
  shinigami: Object.freeze({
    Accept: SHINIGAMI_IMAGE_ACCEPT,
    DNT: "1",
    "sec-fetch-dest": "empty",
    "Sec-GPC": "1"
  })
});

function providerRequestHeaders(source, policyHeaders = {}) {
  const base = {
    Accept: "image/avif,image/webp,image/png,image/jpeg",
    "User-Agent": "NEXORA-Comic-Gateway/1.0"
  };
  return {
    ...base,
    ...(PROVIDER_REQUEST_HEADERS[source] || {}),
    ...policyHeaders
  };
}

export { PROVIDER_REQUEST_HEADERS, SHINIGAMI_IMAGE_ACCEPT, providerRequestHeaders };
