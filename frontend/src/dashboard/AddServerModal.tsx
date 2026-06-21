import React, { useState, useEffect, useCallback } from 'react';
import { X, Save, AlertCircle, CheckCircle, Loader2 } from 'lucide-react';
import { httpBase } from '../services/engineUrl';

interface AddServerModalProps {
  onClose: () => void;
  onSave: (serverIp: string) => void;
  servers: string[];
}

export const AddServerModal: React.FC<AddServerModalProps> = ({ onClose, onSave, servers }) => {
  const [newServerIp, setNewServerIp] = useState('');
  const [isChecking, setIsChecking] = useState(false);
  const [healthStatus, setHealthStatus] = useState<'checking' | 'healthy' | 'unhealthy' | null>(null);
  const [errorMessage, setErrorMessage] = useState('');

  const isValidFormat = /^[a-zA-Z0-9.-]+(:\d+)?$/.test(newServerIp.trim());

  const checkHealthcheck = useCallback(async (ip: string): Promise<boolean> => {
    if (!ip.trim()) return false;
    
    
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      
      const response = await fetch(`${httpBase(ip)}/health?_t=${Date.now()}`, {
        method: 'GET',
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      return response.ok && (await response.json()).status === 'healthy';
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    // Defer the early-reset state writes into a microtask so they
    // aren't synchronous setState calls in the effect body — avoids
    // react-hooks/set-state-in-effect.
    if (!newServerIp.trim() || !isValidFormat) {
      queueMicrotask(() => {
        setHealthStatus(null);
        setErrorMessage('');
      });
      return;
    }

    const timer = setTimeout(async () => {
      setIsChecking(true);
      setHealthStatus('checking');
      setErrorMessage('');

      const isHealthy = await checkHealthcheck(newServerIp);

      setIsChecking(false);

      if (isHealthy) {
        setHealthStatus('healthy');
        setErrorMessage('');
      } else {
        setHealthStatus('unhealthy');
        setErrorMessage('Server is not responding to healthcheck. Make sure the trading engine is running on the specified IP:port.');
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [newServerIp, isValidFormat, checkHealthcheck]);

  const handleSave = () => {
    if (!newServerIp.trim() || servers.includes(newServerIp)) return;
    if (healthStatus !== 'healthy') return;
    onSave(newServerIp);
  };

  const canSave = newServerIp.trim() && !servers.includes(newServerIp) && healthStatus === 'healthy' && isValidFormat;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-slate-800 rounded-lg shadow-xl p-6 w-full max-w-md">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold text-white">Add New Server</h3>
          <button onClick={onClose} title="Close" className="text-slate-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div>
          <label htmlFor="server-ip" className="block text-sm font-medium text-slate-400 mb-2">
            Server IP Address
          </label>
          <input
            type="text"
            id="server-ip"
            autoFocus
            placeholder="ip:port (e.g., localhost:9090)"
            value={newServerIp}
            onChange={(e) => {
              setNewServerIp(e.target.value);
            }}
            onKeyDown={(e) => e.key === 'Enter' && canSave && handleSave()}
            className={`w-full bg-slate-900 border rounded-md px-3 py-2 text-white placeholder-slate-500 focus:outline-none focus:ring-2 ${
              healthStatus === 'unhealthy' ? 'border-red-500 focus:ring-red-500' : 
              healthStatus === 'healthy' ? 'border-green-500 focus:ring-green-500' : 
              'border-slate-700 focus:ring-blue-500'
            }`}
          />
          {healthStatus === 'checking' && (
            <div className="mt-2 flex items-center gap-2 text-yellow-500 text-sm">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Checking server health...</span>
            </div>
          )}
          {healthStatus === 'unhealthy' && (
            <div className="mt-2 flex items-start gap-2 text-red-400 text-sm">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}
          {healthStatus === 'healthy' && (
            <div className="mt-2 flex items-center gap-2 text-green-400 text-sm">
              <CheckCircle className="w-4 h-4" />
              <span>Server is healthy and ready to connect</span>
            </div>
          )}
          {!isValidFormat && newServerIp.trim() && (
            <div className="mt-2 text-yellow-500 text-sm">
              Invalid format. Use ip:port (e.g., localhost:9090)
            </div>
          )}
        </div>
        <div className="mt-6 flex justify-end gap-4">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-slate-300 bg-slate-700 hover:bg-slate-600 rounded-md"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave || isChecking}
            className={`px-4 py-2 text-sm font-medium rounded-md flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed ${
              canSave ? 'text-white bg-blue-600 hover:bg-blue-500' : 'text-slate-400 bg-slate-700'
            }`}
          >
            <Save className="w-4 h-4" />
            Save Server
          </button>
        </div>
      </div>
    </div>
  );
};
