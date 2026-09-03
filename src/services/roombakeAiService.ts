export interface GenerateParams {
  provider: 'gemini' | 'openai' | 'mock' | 'normals';
  model: string;
  prompt: string;
  style: string;
  apiKey?: string;
  sendCond?: boolean;
  images: {
    depth?: HTMLCanvasElement | null;
    normal?: HTMLCanvasElement | null;
    base?: HTMLCanvasElement | null;
    mask?: HTMLCanvasElement | null;
  };
  size?: string;
  quality?: string;
}

export function buildGeminiPrompt(template: string, style: string): string {
  return template.replace(/\{\{\s*STYLE\s*\}\}/g, style || 'a modern photorealistic architectural interior room');
}

export function placeholderImage(
  viewName: string,
  normalCanvas: HTMLCanvasElement | null,
  index: number,
  isMock: boolean
): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  if (!normalCanvas) {
    cv.width = 1024;
    cv.height = 1024;
    const g = cv.getContext('2d')!;
    g.fillStyle = '#222';
    g.fillRect(0, 0, 1024, 1024);
    return cv;
  }

  cv.width = normalCanvas.width;
  cv.height = normalCanvas.height;
  const g = cv.getContext('2d')!;
  g.drawImage(normalCanvas, 0, 0);

  if (!isMock) return cv;

  const hue = (index * 47 + 15) % 360;
  g.globalCompositeOperation = 'overlay';
  g.globalAlpha = 0.55;
  g.fillStyle = `hsl(${hue}, 45%, 52%)`;
  g.fillRect(0, 0, cv.width, cv.height);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';

  g.strokeStyle = 'rgba(255,255,255,0.22)';
  g.lineWidth = 1;
  const step = Math.round(cv.width / 16);
  for (let x = 0; x < cv.width; x += step) {
    g.beginPath();
    g.moveTo(x + 0.5, 0);
    g.lineTo(x + 0.5, cv.height);
    g.stroke();
  }
  for (let y = 0; y < cv.height; y += step) {
    g.beginPath();
    g.moveTo(0, y + 0.5);
    g.lineTo(cv.width, y + 0.5);
    g.stroke();
  }

  g.font = `bold ${Math.round(cv.width / 18)}px sans-serif`;
  g.textAlign = 'center';
  g.fillStyle = 'rgba(0,0,0,0.6)';
  g.fillText(viewName, cv.width / 2 + 2, cv.height / 2 + 2);
  g.fillStyle = 'rgba(255,255,255,0.95)';
  g.fillText(viewName, cv.width / 2, cv.height / 2);
  return cv;
}

export async function loadImageToCanvas(
  fileOrBlobOrUrl: File | Blob | string,
  w?: number,
  h?: number
): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const cv = document.createElement('canvas');
      cv.width = w || img.width;
      cv.height = h || img.height;
      const ctx = cv.getContext('2d')!;
      ctx.drawImage(img, 0, 0, cv.width, cv.height);
      resolve(cv);
    };
    img.onerror = () => reject(new Error('Image failed to load onto canvas'));
    img.src = typeof fileOrBlobOrUrl === 'string'
      ? fileOrBlobOrUrl
      : URL.createObjectURL(fileOrBlobOrUrl);
  });
}

export async function generateTexture(params: GenerateParams): Promise<HTMLCanvasElement> {
  const { provider, model, prompt, style, apiKey, sendCond = true, images } = params;

  if (provider === 'normals') {
    return placeholderImage('Normal Map Test', images.normal || null, 0, false);
  }

  if (provider === 'mock') {
    return placeholderImage('Mock Texture Test', images.normal || null, 1, true);
  }

  // 1. Google Gemini Multimodal Vision API
  if (provider === 'gemini') {
    const key = apiKey || localStorage.getItem('roombake_gemini_key') || '';
    if (!key.trim()) {
      throw new Error('Please provide your Google Gemini API key (from aistudio.google.com).');
    }
    localStorage.setItem('roombake_gemini_key', key.trim());

    if (model.startsWith('imagen')) {
      const imgPayload = {
        instances: [{ prompt: `${prompt} ${style}` }],
        parameters: { sampleCount: 1, aspectRatio: '1:1', outputMimeType: 'image/png' },
      };
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${key.trim()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(imgPayload),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error?.message || `Gemini Imagen Error: ${res.status}`);
      const b64 = j.predictions?.[0]?.bytesBase64Encoded;
      if (!b64) throw new Error('No image returned by Imagen.');
      return await loadImageToCanvas(`data:image/png;base64,${b64}`);
    }

    const parts: any[] = [];
    parts.push({
      text: 'You are an expert 3D architectural rendering and texture synthesis engine. Your goal is to render a photorealistic interior photograph that EXACTLY overlays and matches the 3D geometry, perspective, and vanishing points shown in the reference conditioning maps below.',
    });

    if (sendCond) {
      if (images.depth) {
        parts.push({
          text: '[REFERENCE MAP 1: CAMERA DEPTH MAP]\nThis grayscale map defines surface distance from the camera (darker = near foreground, lighter = distant background). Every room corner, ceiling junction, floor perimeter, and perspective line MUST align with these edges. Do NOT shift, tilt, or alter the camera perspective:',
        });
        parts.push({
          inlineData: {
            mimeType: 'image/png',
            data: images.depth.toDataURL('image/png').split(',')[1],
          },
        });
      }
      if (images.normal) {
        parts.push({
          text: '[REFERENCE MAP 2: SURFACE NORMAL ORIENTATION MAP]\nThis color-coded normal map defines the precise 3D plane orientation:\n- Vertical walls are colored in cyan, magenta, and blue tones.\n- Horizontal floors and ceilings are colored in green/yellow tones.\nRender clean architectural surfaces conforming strictly to these plane boundaries without introducing false architectural elements:',
        });
        parts.push({
          inlineData: {
            mimeType: 'image/png',
            data: images.normal.toDataURL('image/png').split(',')[1],
          },
        });
      }
      if (images.base) {
        parts.push({
          text: '[PRIMARY GROUND-TRUTH ANCHOR: PARTIALLY TEXTURED ROOM VIEW]\nThis reference shows the camera view with surfaces ALREADY TEXTURED in earlier bakes.\n\nCRITICAL SEAMLESS TEXTURE EXTENSION DIRECTIVES:\n1. Treat already-textured surfaces as your ABSOLUTE GROUND TRUTH.\n2. Sample the exact texture, material type, wood grain/plaster pattern, panel seams, and color palette directly from the textured portion.\n3. SEAMLESSLY EXTEND AND CONTINUE that exact material across the untextured/blank areas.\n4. INVISIBLE TRANSITION: The seam where existing texture meets new texture MUST be 100% invisible.',
        });
        parts.push({
          inlineData: {
            mimeType: 'image/png',
            data: images.base.toDataURL('image/png').split(',')[1],
          },
        });
      }
    }

    const fullPrompt = buildGeminiPrompt(
      prompt || 'A photorealistic architectural interior photograph of {{STYLE}}, cinematic studio illumination, realistic textures, highly detailed, 8k resolution',
      style
    );

    parts.push({
      text: `[RENDER TASK & SPECIFICATIONS]\nSynthesize the photorealistic architectural interior photograph adhering strictly to the geometry above and following these style specifications:\n\nSCENE STYLE & MATERIALS:\n${fullPrompt}\n\nMANDATORY 3D GEOMETRY & CONTINUITY RULES:\n1. SEAMLESS TEXTURE CONTINUATION: Sample and seamlessly continue materials from the reference anchor into blank areas.\n2. STRICT PERSPECTIVE LOCK: Every corner and wall seam must line up pixel-for-pixel with depth and normal maps.\n3. ARCHITECTURAL TEXTURES: Paint realistic materials (wood parquet, stone, drywall, plaster, concrete, metal) onto each surface plane.\n4. DIFFUSE LIGHTING: Use soft, flat, diffused architectural photography lighting with clean ambient illumination.\n5. Output ONLY the generated photograph.`,
    });

    const payload = {
      contents: [{ parts }],
      generationConfig: {
        responseModalities: ['IMAGE', 'TEXT'],
      },
    };

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key.trim()}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );

    const j = await res.json();
    if (!res.ok) {
      throw new Error(j.error?.message || `Gemini API Error: ${res.status}`);
    }

    const cParts = j.candidates?.[0]?.content?.parts || [];
    for (const p of cParts) {
      if (p.inlineData && p.inlineData.data) {
        const mime = p.inlineData.mimeType || 'image/png';
        return await loadImageToCanvas(`data:${mime};base64,${p.inlineData.data}`);
      }
    }
    throw new Error('Gemini API did not return an image part. Please try another model or prompt.');
  }

  // 2. OpenAI API
  if (provider === 'openai') {
    const key = apiKey || localStorage.getItem('roombake_openai_key') || '';
    if (!key.trim()) {
      throw new Error('Please provide your OpenAI API key.');
    }
    localStorage.setItem('roombake_openai_key', key.trim());

    const genModel = model || 'dall-e-3';
    const payload: any = {
      model: genModel,
      prompt: `${prompt} ${style}`.slice(0, 4000),
      n: 1,
      size: params.size || '1024x1024',
    };
    if (genModel === 'dall-e-3') {
      payload.quality = params.quality || 'standard';
    }

    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key.trim()}`,
      },
      body: JSON.stringify(payload),
    });

    const j = await res.json();
    if (!res.ok) {
      throw new Error(j.error?.message || `OpenAI Error: ${res.status}`);
    }

    if (j.data?.[0]?.b64_json) {
      return await loadImageToCanvas(`data:image/png;base64,${j.data[0].b64_json}`);
    }
    if (j.data?.[0]?.url) {
      return await loadImageToCanvas(j.data[0].url);
    }
    throw new Error('No image returned by OpenAI API.');
  }

  throw new Error(`Unsupported provider: ${provider}`);
}
