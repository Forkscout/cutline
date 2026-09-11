/**
 * Reading a cut-off WebM up to its last complete block.
 *
 * A tab that dies mid-take leaves a file that ends wherever the last chunk
 * ended — and MediaRecorder's chunks follow a timer, not the file's
 * structure, so that is usually part-way through a block. Demuxers treat a
 * cluster with a broken tail as unreadable and drop the whole of it. For a
 * low-motion screen capture, where keyframes and therefore clusters are far
 * apart, that measured at 27 seconds of a 57-second take.
 *
 * MediaRecorder writes its clusters with an unknown size, so a cluster that
 * simply ends early is valid as long as it ends on an element boundary. This
 * finds the last cluster and the end of its last complete element; cutting the
 * file there loses only the block that was never fully written — 1 second of
 * that same take instead of 27.
 */

const CLUSTER_ID = [0x1f, 0x43, 0xb6, 0x75] as const;
/** Every MediaRecorder cluster opens with its timecode; used to reject look-alikes. */
const TIMECODE_ID = 0xe7;
/** How much of the file's tail to examine, growing until a cluster is found. */
const WINDOWS = [4, 32, 256].map((mb) => mb * 1024 * 1024);

interface Vint {
  len: number;
  value: number;
  unknown: boolean;
}

/** An EBML variable-length integer: an element ID, or a size. */
function vint(bytes: Uint8Array, at: number, isId: boolean): Vint | null {
  const first = bytes[at];
  if (first === undefined || first === 0) return null;
  let len = 1;
  let mask = 0x80;
  while (!(first & mask)) {
    len += 1;
    mask >>= 1;
  }
  if (at + len > bytes.length) return null;
  let value = isId ? first : first & (mask - 1);
  for (let i = 1; i < len; i += 1) value = value * 256 + (bytes[at + i] ?? 0);
  return { len, value, unknown: !isId && value === 2 ** (7 * len) - 1 };
}

function lastCluster(bytes: Uint8Array): number | null {
  for (let i = bytes.length - 4; i >= 0; i -= 1) {
    if (
      bytes[i] !== CLUSTER_ID[0] ||
      bytes[i + 1] !== CLUSTER_ID[1] ||
      bytes[i + 2] !== CLUSTER_ID[2] ||
      bytes[i + 3] !== CLUSTER_ID[3]
    ) {
      continue;
    }
    const size = vint(bytes, i + 4, false);
    // Those four bytes turn up inside compressed video by chance; a real
    // cluster is followed by a size and then its timecode.
    if (size && bytes[i + 4 + size.len] === TIMECODE_ID) return i;
  }
  return null;
}

/** Offset just past the final cluster's last complete element. */
function completeEnd(bytes: Uint8Array, cluster: number): number {
  const size = vint(bytes, cluster + 4, false);
  // Only unknown-size clusters — MediaRecorder's kind — can end early and stay
  // valid. A sized one would need its size rewritten; leave it alone.
  if (!size || !size.unknown) return bytes.length;
  let at = cluster + 4 + size.len;
  let good = at;
  while (at < bytes.length) {
    const id = vint(bytes, at, true);
    if (!id) break;
    const length = vint(bytes, at + id.len, false);
    if (!length || length.unknown) break;
    const next = at + id.len + length.len + length.value;
    if (next > bytes.length) break;
    at = next;
    good = at;
  }
  return good;
}

/**
 * How many bytes of `file` to keep: all of it when it is whole or its layout
 * is not recognised, otherwise the end of the last complete element.
 */
export async function salvageLength(file: Blob): Promise<number> {
  for (const window of WINDOWS) {
    const start = Math.max(0, file.size - window);
    const bytes = new Uint8Array(await file.slice(start).arrayBuffer());
    const cluster = lastCluster(bytes);
    if (cluster !== null) return start + completeEnd(bytes, cluster);
    if (start === 0) break;
  }
  return file.size;
}
