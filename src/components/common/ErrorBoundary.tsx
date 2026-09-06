import { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[ErrorBoundary caught error]:', error, errorInfo);
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="h-screen w-screen bg-[#0d0f14] text-gray-200 flex flex-col items-center justify-center p-6 select-none font-mono">
          <div className="max-w-md w-full bg-[#151921] border border-red-500/30 rounded-2xl p-6 shadow-2xl flex flex-col items-center text-center">
            <div className="w-14 h-14 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center mb-4 text-red-400">
              <AlertTriangle className="w-7 h-7" />
            </div>
            <h2 className="text-lg font-bold text-white mb-2">Studio Render Alert</h2>
            <p className="text-xs text-gray-400 mb-4 leading-relaxed font-sans">
              An unexpected error occurred during rendering. Your project progress has been safely preserved.
            </p>
            {this.state.error && (
              <div className="w-full bg-[#0a0c10] border border-gray-800 rounded-lg p-3 mb-5 text-left overflow-auto max-h-32 text-[11px] text-red-300">
                {this.state.error.message || 'Unknown runtime error'}
              </div>
            )}
            <div className="flex gap-3 w-full">
              <button
                onClick={this.handleReset}
                className="flex-1 py-2.5 px-4 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white text-xs font-semibold flex items-center justify-center gap-2 transition-all shadow-lg shadow-blue-500/20"
              >
                <RefreshCw className="w-3.5 h-3.5" /> Resume Studio
              </button>
              <button
                onClick={() => window.location.reload()}
                className="py-2.5 px-4 rounded-xl bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs font-semibold transition-all"
              >
                Reload
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
