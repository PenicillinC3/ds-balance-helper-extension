/**
 * 测试辅助：生成一个最小可用的 ZIP（store 方式，不压缩）。
 * 官方「用量信息」页导出的就是 ZIP，用它可以真正走一遍 parseZip。
 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * @param {Array<{name: string, text: string}>} entries
 * @returns {Buffer}
 */
function makeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  entries.forEach((entry) => {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const dataBuf = Buffer.from(entry.text, 'utf8');
    const crc = crc32(dataBuf);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);      // version needed
    local.writeUInt16LE(0x0800, 6);  // flag: 文件名为 UTF-8
    local.writeUInt16LE(0, 8);       // method: store
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(dataBuf.length, 18); // 压缩后大小
    local.writeUInt32LE(dataBuf.length, 22); // 原始大小
    local.writeUInt16LE(nameBuf.length, 26);
    localParts.push(local, nameBuf, dataBuf);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);         // method
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(dataBuf.length, 20);
    cd.writeUInt32LE(dataBuf.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);    // 本地头偏移
    centralParts.push(cd, nameBuf);

    offset += local.length + nameBuf.length + dataBuf.length;
  });

  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);   // 本盘条目数
  eocd.writeUInt16LE(entries.length, 10);  // 总条目数
  eocd.writeUInt32LE(central.length, 12);  // 中央目录大小
  eocd.writeUInt32LE(offset, 16);          // 中央目录偏移

  return Buffer.concat([...localParts, central, eocd]);
}

/** 生成一个 .zip 的 File 对象，可直接喂给 DS_BILL.parseFiles */
function zipFile(name, entries) {
  return new File([makeZip(entries)], name, { type: 'application/zip' });
}

module.exports = { makeZip, zipFile, crc32 };
