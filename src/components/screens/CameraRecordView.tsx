import React, { useState, useEffect } from 'react';
import { Project } from '../../types';
import { ThreeStage } from '../viewport/ThreeStage';

interface CameraRecordViewProps {
  currentProject: Project;
}

export const CameraRecordView: React.FC<CameraRecordViewProps> = ({ currentProject }) => {
  const [isRecording, setIsRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const [showQRPairing, setShowQRPairing] = useState(false);
  const [focalLength, setFocalLength] = useState('35mm');
  const [iso, setIso] = useState('800');

  const assets = currentProject.scenes || [];

  useEffect(() => {
    let timer: any;
    if (isRecording) {
      timer = setInterval(() => {
        setRecSeconds((prev) => prev + 1);
      }, 1000);
    }
    return () => clearInterval(timer);
  }, [isRecording]);

  return (
    <div className="relative w-full h-[calc(100vh-61px)] overflow-hidden bg-background">
      {/* 3D Scene Viewport */}
      <ThreeStage assets={assets} selectedAssetId={null} />

      {/* Cinematic Viewfinder HUD Overlay */}
      <div className="absolute inset-0 pointer-events-none p-lg flex flex-col justify-between z-20">
        {/* Top HUD */}
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-md">
            <div className="flex items-center gap-xs bg-background/80 backdrop-blur-md px-md py-xs rounded border border-outline-variant/30 font-label-caps text-xs">
              <span className={`w-2 h-2 rounded-full ${isRecording ? 'bg-red-500 animate-ping' : 'bg-green-500'}`} />
              <span className="text-primary tracking-widest">{isRecording ? 'RECORDING' : 'STANDBY'}</span>
            </div>
            {isRecording && (
              <span className="font-label-caps text-xs text-red-400 tracking-widest bg-background/80 px-sm py-xs border border-red-500/40 rounded">
                REC 00:{recSeconds.toString().padStart(2, '0')}
              </span>
            )}
          </div>

          <div className="flex items-center gap-sm font-label-caps text-xs text-on-surface-variant bg-background/80 backdrop-blur-md px-md py-xs rounded border border-outline-variant/30">
            <span>FL: {focalLength}</span>
            <span className="text-outline-variant">|</span>
            <span>ISO: {iso}</span>
            <span className="text-outline-variant">|</span>
            <span className="text-primary font-medium">60 FPS</span>
          </div>
        </div>

        {/* Center Crosshair Grid Overlay */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-64 h-48 border border-primary/20 pointer-events-none flex items-center justify-center">
          <div className="w-4 h-4 border-t-2 border-l-2 border-primary/40 absolute top-0 left-0" />
          <div className="w-4 h-4 border-t-2 border-r-2 border-primary/40 absolute top-0 right-0" />
          <div className="w-4 h-4 border-b-2 border-l-2 border-primary/40 absolute bottom-0 left-0" />
          <div className="w-4 h-4 border-b-2 border-r-2 border-primary/40 absolute bottom-0 right-0" />
          <div className="w-2 h-2 bg-primary/40 rounded-full" />
        </div>

        {/* Bottom Floating Control Bar */}
        <div className="flex justify-between items-end pointer-events-auto">
          {/* Mobile Camera Pairing Button */}
          <button
            onClick={() => setShowQRPairing(true)}
            className="bg-surface-container/90 border border-outline-variant/40 hover:border-primary px-md py-sm rounded-lg backdrop-blur-md text-xs font-label-caps text-primary tracking-widest flex items-center gap-xs cursor-pointer shadow-lg"
          >
            <span className="material-symbols-outlined text-[18px]">qr_code_scanner</span>
            PAIR PHONE / TABLET
          </button>

          {/* Record Trigger */}
          <div className="flex items-center gap-md">
            <button
              onClick={() => {
                setIsRecording(!isRecording);
                if (!isRecording) setRecSeconds(0);
              }}
              className={`w-14 h-14 rounded-full flex items-center justify-center cursor-pointer shadow-2xl transition-transform hover:scale-105 ${
                isRecording
                  ? 'bg-red-600 ring-4 ring-red-400/40 text-white'
                  : 'bg-primary text-background'
              }`}
              title={isRecording ? 'Stop Recording' : 'Start Capture'}
            >
              <span className="material-symbols-outlined text-[28px]">
                {isRecording ? 'stop' : 'videocam'}
              </span>
            </button>
          </div>

          {/* Lens & ISO Presets */}
          <div className="flex flex-col gap-xs items-end">
            <div className="flex items-center gap-xs bg-surface-container/90 border border-outline-variant/40 p-xs rounded-lg backdrop-blur-md">
              <span className="font-label-caps text-[9px] text-on-surface-variant px-xs">LENS</span>
              {['24mm', '35mm', '50mm', '85mm'].map((fl) => (
                <button
                  key={fl}
                  onClick={() => setFocalLength(fl)}
                  className={`px-sm py-xs text-[11px] font-label-caps rounded cursor-pointer ${
                    focalLength === fl ? 'bg-primary text-background font-medium' : 'text-on-surface-variant hover:text-primary'
                  }`}
                >
                  {fl}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-xs bg-surface-container/90 border border-outline-variant/40 p-xs rounded-lg backdrop-blur-md">
              <span className="font-label-caps text-[9px] text-on-surface-variant px-xs">ISO</span>
              {['400', '800', '1600'].map((val) => (
                <button
                  key={val}
                  onClick={() => setIso(val)}
                  className={`px-sm py-xs text-[11px] font-label-caps rounded cursor-pointer ${
                    iso === val ? 'bg-primary text-background font-medium' : 'text-on-surface-variant hover:text-primary'
                  }`}
                >
                  {val}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* QR Pairing Modal for Module 3 */}
      {showQRPairing && (
        <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-md flex items-center justify-center p-md">
          <div className="bg-surface-container border border-outline-variant/40 p-xl max-w-sm w-full rounded-xl shadow-2xl text-center relative">
            <button
              onClick={() => setShowQRPairing(false)}
              className="absolute top-md right-md text-on-surface-variant hover:text-primary cursor-pointer"
            >
              ✕
            </button>
            <span className="font-label-caps text-[11px] text-primary tracking-widest block mb-xs">
              MODULE 03: VIRTUAL CAMERA
            </span>
            <h3 className="font-headline-sm text-primary mb-md font-semibold">
              Connect Mobile Director
            </h3>
            <div className="w-48 h-48 mx-auto bg-white p-md rounded-lg flex flex-col items-center justify-center border border-outline-variant/40 mb-md">
              <span className="material-symbols-outlined text-background text-[110px]">
                qr_code_2
              </span>
            </div>
            <p className="text-xs text-on-surface-variant mb-md leading-relaxed">
              Scan with your iPhone, iPad or Android device to enable real-time gyroscope & motion camera tracking.
            </p>
            <button
              onClick={() => setShowQRPairing(false)}
              className="w-full font-label-caps text-xs bg-primary text-background py-sm rounded font-medium cursor-pointer"
            >
              DONE
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
