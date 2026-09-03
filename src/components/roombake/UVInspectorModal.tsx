import React, { useEffect, useRef, useState } from 'react';
import { RoomBakeEngine } from '../../services/roombakeEngine';

interface UVInspectorModalProps {
  engine: RoomBakeEngine | null;
  isOpen: boolean;
  onClose: () => void;
}

export const UVInspectorModal: React.FC<UVInspectorModalProps> = ({ engine, isOpen, onClose }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [overlayTexture, setOverlayTexture] = useState(true);
  const [triCount, setTriCount] = useState(0);

  useEffect(() => {
    if (!isOpen || !engine || !canvasRef.current) return;
    const count = engine.drawUVWireframe(canvasRef.current, overlayTexture);
    setTriCount(count);
  }, [isOpen, engine, overlayTexture]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-fade-in">
      <div className="relative w-full max-w-4xl bg-surface-container-low border border-surface-container-highest flex flex-col max-h-[90vh] shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-container-highest bg-surface-container">
          <div className="flex items-center gap-3">
            <span className="material-symbols-outlined text-primary text-[24px]">grid_4x4</span>
            <div>
              <h2 className="text-base font-semibold text-on-surface tracking-wide">
                UV Layout Inspector
              </h2>
              <p className="text-xs text-on-surface-variant font-mono">
                {engine?.state.modelName || '3D Geometry'} · {triCount.toLocaleString()} Triangles · Atlas: {engine?.config.atlas}×{engine?.config.atlas}px
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-on-surface-variant hover:text-on-surface p-1 rounded transition-colors"
          >
            <span className="material-symbols-outlined text-[22px]">close</span>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 flex flex-col items-center justify-center p-6 bg-surface-container-lowest overflow-auto">
          <div className="relative border border-outline-variant/30 rounded shadow-inner bg-black/60 max-w-[640px] max-h-[640px] w-full aspect-square flex items-center justify-center">
            <canvas
              ref={canvasRef}
              width={1024}
              height={1024}
              className="w-full h-full object-contain"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-surface-container-highest bg-surface-container">
          <label className="flex items-center gap-2 cursor-pointer text-xs font-mono text-on-surface-variant select-none">
            <input
              type="checkbox"
              checked={overlayTexture}
              onChange={(e) => setOverlayTexture(e.target.checked)}
              className="accent-primary rounded"
            />
            Overlay Baked Texture
          </label>
          <div className="flex items-center gap-3">
            <button
              onClick={() => {
                if (canvasRef.current) {
                  const link = document.createElement('a');
                  link.download = 'uv-wireframe.png';
                  link.href = canvasRef.current.toDataURL('image/png');
                  link.click();
                }
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-container-high border border-outline-variant text-xs text-on-surface font-medium hover:bg-surface-container-highest transition-colors"
            >
              <span className="material-symbols-outlined text-[16px]">download</span>
              Download Wireframe PNG
            </button>
            <button
              onClick={onClose}
              className="px-4 py-1.5 bg-primary text-on-primary font-medium text-xs tracking-wider uppercase hover:opacity-90 transition-opacity"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
