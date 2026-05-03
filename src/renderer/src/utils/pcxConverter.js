// ── pcxConverter.js ───────────────────────────────────────────────────────────
// Conversión de imagen a PCX 8bpp indexado con paleta del juego.
// Todo en el renderer, sin dependencias externas.

// ── Cuantización: nearest-neighbor con distancia euclidiana ──────────────────

function nearestPaletteIndex(r, g, b, palette) {
  let best = 0
  let bestDist = Infinity
  for (let i = 0; i < palette.length; i++) {
    const [pr, pg, pb] = palette[i]
    const dr = r - pr, dg = g - pg, db = b - pb
    const dist = dr * dr + dg * dg + db * db
    if (dist < bestDist) { bestDist = dist; best = i }
    if (dist === 0) break
  }
  return best
}

// ── Floyd-Steinberg dithering ─────────────────────────────────────────────────

function ditherFloydSteinberg(pixels, width, height, palette) {
  // pixels: Uint8ClampedArray RGBA, se modifica in-place para propagar error
  const err = new Float32Array(width * height * 3) // buffer de error RGB

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const ei = (y * width + x) * 3

      const r = Math.max(0, Math.min(255, pixels[i]     + err[ei]))
      const g = Math.max(0, Math.min(255, pixels[i + 1] + err[ei + 1]))
      const b = Math.max(0, Math.min(255, pixels[i + 2] + err[ei + 2]))

      const idx = nearestPaletteIndex(r, g, b, palette)
      const [pr, pg, pb] = palette[idx]

      const er = r - pr, eg = g - pg, eb = b - pb

      // Propagar error a vecinos
      const distribute = (nx, ny, factor) => {
        if (nx < 0 || nx >= width || ny >= height) return
        const ni = (ny * width + nx) * 3
        err[ni]     += er * factor
        err[ni + 1] += eg * factor
        err[ni + 2] += eb * factor
      }
      distribute(x + 1, y,     7 / 16)
      distribute(x - 1, y + 1, 3 / 16)
      distribute(x,     y + 1, 5 / 16)
      distribute(x + 1, y + 1, 1 / 16)

      // Guardar índice en canal R (reutilizamos el buffer)
      pixels[i] = idx
    }
  }
}

// ── Encoder PCX v5 RLE 8bpp ───────────────────────────────────────────────────

export function encodePCX(indices, width, height, palette) {
  // Header PCX (128 bytes)
  const header = new Uint8Array(128)
  const dv = new DataView(header.buffer)
  header[0] = 0x0A          // manufacturer
  header[1] = 0x05          // version 5
  header[2] = 0x01          // encoding RLE
  header[3] = 0x08          // bits per pixel
  dv.setUint16(4,  0, true) // xMin
  dv.setUint16(6,  0, true) // yMin
  dv.setUint16(8,  width  - 1, true) // xMax
  dv.setUint16(10, height - 1, true) // yMax
  dv.setUint16(12, 72, true) // hDPI
  dv.setUint16(14, 72, true) // vDPI
  // bytes 16-63: paleta EGA (vacía para 8bpp)
  header[65] = 0x01          // color planes
  dv.setUint16(66, width, true) // bytes per line
  dv.setUint16(68, 0x01, true)  // palette info (color)

  // Codificación RLE por filas
  const rleRows = []
  let rleSize = 0
  for (let y = 0; y < height; y++) {
    const row = []
    let x = 0
    while (x < width) {
      const val = indices[y * width + x]
      let count = 1
      while (count < 63 && x + count < width && indices[y * width + x + count] === val) {
        count++
      }
      if (count > 1 || val >= 0xC0) {
        row.push(0xC0 | count, val)
      } else {
        row.push(val)
      }
      x += count
    }
    rleRows.push(row)
    rleSize += row.length
  }

  // Paleta extendida (769 bytes: marcador 0x0C + 256×3)
  const palBuf = new Uint8Array(769)
  palBuf[0] = 0x0C
  for (let i = 0; i < 256; i++) {
    const c = palette[i] || [0, 0, 0]
    palBuf[1 + i * 3]     = c[0]
    palBuf[1 + i * 3 + 1] = c[1]
    palBuf[1 + i * 3 + 2] = c[2]
  }

  // Ensamblar fichero final
  const total = 128 + rleSize + 769
  const out = new Uint8Array(total)
  out.set(header, 0)
  let pos = 128
  for (const row of rleRows) {
    for (const byte of row) { out[pos++] = byte }
  }
  out.set(palBuf, pos)
  return out
}

/**
 * Decodifica un buffer PCX a array de índices de paleta (sin convertir a RGBA).
 * Necesario para el editor de píxeles, que trabaja con índices directos.
 * @returns {{ indices: Uint8Array, width: number, height: number, embeddedPalette: number[][]|null }}
 */
export function decodePCXToIndexed(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset)
  const w   = dv.getUint16(8,  true) + 1
  const h   = dv.getUint16(10, true) + 1
  const bpl = dv.getUint16(66, true)  // bytes per line (puede incluir padding)

  // Decodificar RLE
  const raw = new Uint8Array(bpl * h)
  let pos = 128, out = 0
  while (out < raw.length && pos < buf.length - 769) {
    const byte = buf[pos++]
    if ((byte & 0xC0) === 0xC0) {
      const count = byte & 0x3F, val = buf[pos++]
      for (let i = 0; i < count && out < raw.length; i++) raw[out++] = val
    } else { raw[out++] = byte }
  }

  // Recortar padding (bpl puede ser > w)
  const indices = new Uint8Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      indices[y * w + x] = raw[y * bpl + x]

  // Paleta embebida
  const palOff = buf.length - 769
  const embeddedPalette = buf[palOff] === 0x0C
    ? Array.from({ length: 256 }, (_, i) => [buf[palOff+1+i*3], buf[palOff+2+i*3], buf[palOff+3+i*3]])
    : null

  return { indices, width: w, height: h, embeddedPalette }
}

// ── API pública ───────────────────────────────────────────────────────────────

/**
 * Convierte un ImageData (de Canvas) a PCX usando la paleta del juego.
 * @param {ImageData} imageData  - pixeles RGBA de la región de origen
 * @param {number}    outW       - ancho de salida en píxeles
 * @param {number}    outH       - alto de salida en píxeles
 * @param {number[][]} palette   - paleta del juego [[r,g,b]×256]
 * @param {boolean}   dithering  - usar Floyd-Steinberg
 * @returns {{ pcxBuffer: Uint8Array, previewUrl: string, indices: Uint8Array }}
 */
export function convertToPCX(imageData, outW, outH, palette, dithering = false) {
  // 1. Escalar la región de origen a (outW × outH) usando un canvas offscreen
  const srcCanvas = new OffscreenCanvas(imageData.width, imageData.height)
  srcCanvas.getContext('2d').putImageData(imageData, 0, 0)

  const dstCanvas = new OffscreenCanvas(outW, outH)
  const dstCtx = dstCanvas.getContext('2d')
  dstCtx.imageSmoothingEnabled = true
  dstCtx.imageSmoothingQuality = 'high'
  dstCtx.drawImage(srcCanvas, 0, 0, outW, outH)

  const scaled = dstCtx.getImageData(0, 0, outW, outH)
  const pixels = new Uint8ClampedArray(scaled.data)

  // 2. Mapear alpha < 128 → índice 0 (magenta transparencia)
  const indices = new Uint8Array(outW * outH)

  if (dithering) {
    ditherFloydSteinberg(pixels, outW, outH, palette)
    for (let i = 0; i < outW * outH; i++) {
      const a = scaled.data[i * 4 + 3]
      indices[i] = a < 128 ? 0 : pixels[i * 4]
    }
  } else {
    for (let i = 0; i < outW * outH; i++) {
      const a = scaled.data[i * 4 + 3]
      if (a < 128) { indices[i] = 0; continue }
      const r = pixels[i * 4], g = pixels[i * 4 + 1], b = pixels[i * 4 + 2]
      indices[i] = nearestPaletteIndex(r, g, b, palette)
    }
  }

  // 3. Generar buffer PCX
  const pcxBuffer = encodePCX(indices, outW, outH, palette)

  // 4. Generar preview como data URL (dibujando los índices con la paleta)
  const previewCanvas = new OffscreenCanvas(outW, outH)
  const pCtx = previewCanvas.getContext('2d')
  const previewData = pCtx.createImageData(outW, outH)
  for (let i = 0; i < outW * outH; i++) {
    const idx = indices[i]
    const [r, g, b] = idx === 0 ? [255, 0, 255] : (palette[idx] || [0, 0, 0])
    previewData.data[i * 4]     = r
    previewData.data[i * 4 + 1] = g
    previewData.data[i * 4 + 2] = b
    previewData.data[i * 4 + 3] = idx === 0 ? 0 : 255
  }
  pCtx.putImageData(previewData, 0, 0)

  // Convertir a blob/URL de forma síncrona usando canvas 2D normal
  const url = pcxToDataURL(indices, outW, outH, palette)

  return { pcxBuffer, previewUrl: url, indices }
}

/**
 * Genera una data URL PNG de visualización a partir de índices de paleta.
 */
function pcxToDataURL(indices, width, height, palette) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  const imgData = ctx.createImageData(width, height)
  for (let i = 0; i < width * height; i++) {
    const idx = indices[i]
    const [r, g, b] = idx === 0 ? [255, 0, 255] : (palette[idx] || [0, 0, 0])
    imgData.data[i * 4]     = r
    imgData.data[i * 4 + 1] = g
    imgData.data[i * 4 + 2] = b
    imgData.data[i * 4 + 3] = idx === 0 ? 0 : 255
  }
  ctx.putImageData(imgData, 0, 0)
  return canvas.toDataURL('image/png')
}

/**
 * Normaliza un nombre de fichero para asset PCX (sin límite de longitud).
 */
export function normalizePcxName(name) {
  const dotIdx = name.lastIndexOf('.')
  let base = dotIdx > 0 ? name.slice(0, dotIdx) : name

  base = base
    .toUpperCase()
    .replace(/\s+/g, '_')
    .replace(/[^A-Z0-9_]/g, '')

  if (!base) base = 'ASSET'
  return base + '.PCX'
}

/** @deprecated usar normalizePcxName */
export function normalizeFilename8dot3(name) { return normalizePcxName(name) }

/**
 * Lee un fichero como ImageData usando Canvas API.
 * Soporta PNG, JPG, BMP, y PCX (solo lectura básica para preview).
 */
export function loadImageFile(file) {
  // PCX files cannot be decoded by the browser's Image element — handle them natively
  if (file.name.toLowerCase().endsWith('.pcx')) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = (e) => {
        try {
          const buf = new Uint8Array(e.target.result)
          const dv  = new DataView(buf.buffer)
          const w   = dv.getUint16(8, true) + 1
          const h   = dv.getUint16(10, true) + 1
          const bpl = dv.getUint16(66, true)

          // Decode RLE
          const pixels = new Uint8Array(bpl * h)
          let pos = 128, out = 0
          while (out < pixels.length && pos < buf.length - 769) {
            const byte = buf[pos++]
            if ((byte & 0xC0) === 0xC0) {
              const count = byte & 0x3F, val = buf[pos++]
              for (let i = 0; i < count && out < pixels.length; i++) pixels[out++] = val
            } else { pixels[out++] = byte }
          }

          // Read embedded palette
          const palOff = buf.length - 769
          const pal = buf[palOff] === 0x0C
            ? Array.from({ length: 256 }, (_, i) => [buf[palOff+1+i*3], buf[palOff+2+i*3], buf[palOff+3+i*3]])
            : Array.from({ length: 256 }, (_, i) => [i, i, i])

          // Build RGBA ImageData
          const canvas  = document.createElement('canvas')
          canvas.width  = w; canvas.height = h
          const ctx     = canvas.getContext('2d')
          const imgData = ctx.createImageData(w, h)
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              const idx = pixels[y * bpl + x]
              const [r, g, b] = pal[idx]
              const p = (y * w + x) * 4
              imgData.data[p]=r; imgData.data[p+1]=g; imgData.data[p+2]=b
              imgData.data[p+3] = idx === 0 ? 0 : 255
            }
          }
          ctx.putImageData(imgData, 0, 0)
          const imageData = ctx.getImageData(0, 0, w, h)
          resolve({ imageData, width: w, height: h, fileName: file.name })
        } catch (err) { reject(new Error('PCX no válido: ' + err.message)) }
      }
      reader.onerror = () => reject(new Error('Error leyendo fichero PCX'))
      reader.readAsArrayBuffer(file)
    })
  }

  // PNG / JPG / BMP — use browser Image decoding
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width  = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, 0, 0)
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
      URL.revokeObjectURL(url)
      resolve({ imageData, width: img.naturalWidth, height: img.naturalHeight, fileName: file.name })
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('No se pudo cargar la imagen')) }
    img.src = url
  })
}

/**
 * Lee un buffer PCX y genera una data URL PNG para visualización.
 * Exportada para uso en RoomManager y SceneEditor.
 */

export function getPcxDimensions(buf) {
  try {
    const dv = new DataView(buf.buffer, buf.byteOffset)
    const w = dv.getUint16(8, true) + 1
    const h = dv.getUint16(10, true) + 1
    return { w, h }
  } catch { return null }
}

export function pcxFileToDataURL(buf, palette) {
  try {
    const dv = new DataView(buf.buffer, buf.byteOffset)
    const w = dv.getUint16(8, true) + 1
    const h = dv.getUint16(10, true) + 1
    const bytesPerLine = dv.getUint16(66, true)

    const pixels = new Uint8Array(bytesPerLine * h)
    let pos = 128, out = 0
    while (out < pixels.length && pos < buf.length - 769) {
      const byte = buf[pos++]
      if ((byte & 0xC0) === 0xC0) {
        const count = byte & 0x3F
        const val = buf[pos++]
        for (let i = 0; i < count && out < pixels.length; i++) pixels[out++] = val
      } else {
        pixels[out++] = byte
      }
    }

    const palOffset = buf.length - 769
    const usePalette = buf[palOffset] === 0x0C
      ? Array.from({ length: 256 }, (_, i) => [
          buf[palOffset + 1 + i * 3],
          buf[palOffset + 2 + i * 3],
          buf[palOffset + 3 + i * 3],
        ])
      : palette

    const canvas = document.createElement('canvas')
    canvas.width = w; canvas.height = h
    const ctx = canvas.getContext('2d')
    const imgData = ctx.createImageData(w, h)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = pixels[y * bytesPerLine + x]
        const [r, g, b] = usePalette[idx] || [0, 0, 0]
        const p = (y * w + x) * 4
        imgData.data[p]   = r; imgData.data[p+1] = g
        imgData.data[p+2] = b; imgData.data[p+3] = idx === 0 ? 0 : 255
      }
    }
    ctx.putImageData(imgData, 0, 0)
    return canvas.toDataURL('image/png')
  } catch { return null }
}
