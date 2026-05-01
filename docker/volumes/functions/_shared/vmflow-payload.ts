
export function encodePayloadWithXOR(passkey: string, payload: Uint8Array): Uint8Array {

  let chk = payload.slice(0, -1).reduce((acc, val) => acc + val, 0);
  payload[payload.length - 1] = chk;

  for(let k= 0; k < passkey.length; k++){
    payload[k + 1] ^= passkey.charCodeAt(k);
  }

  return payload
}

export function decodePayloadWithXOR(passkey: string, payload: Uint8Array): Uint8Array {

  for(let k= 0; k < passkey.length; k++){
    payload[k + 1] ^= passkey.charCodeAt(k);
  }

  let chk = payload.slice(0, -1).reduce((acc, val) => acc + val, 0);

  if(payload[payload.length - 1] !== (chk & 0xff)){
    throw new Error("Invalid checksum");
  }

  return payload
}
