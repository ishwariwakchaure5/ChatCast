// CRC32 Table-based implementation
const makeCRCTable = () => {
  let c;
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) {
      c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
    }
    crcTable[n] = c;
  }
  return crcTable;
}

const crcTable = makeCRCTable();

export const crc32 = (buf) => {
  const bytes = new Uint8Array(buf);
  let crc = 0 ^ (-1);
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 0xFF];
  }
  return (crc ^ (-1)) >>> 0;
}

export const calculateIntegrityChecksum = (dataBuffer, seq) => {
    const localCrc = crc32(dataBuffer);
    const integrityValue = (localCrc ^ seq) >>> 0;
    return integrityValue.toString(16).padStart(8, '0');
}
