import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown, Trash2 } from 'lucide-react';

interface CustomDropdownProps {
  options: string[];
  selected: string;
  onChange: (option: string) => void;
  // Optional callback enabling per-option removal. The protected option (e.g.
  // the default server) is the one that is NOT shown a delete button.
  onRemove?: (option: string) => void;
  protectedOption?: string;
}

export const CustomDropdown: React.FC<CustomDropdownProps> = ({
  options, selected, onChange, onRemove, protectedOption,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  const handleSelect = (option: string) => {
    onChange(option);
    setIsOpen(false);
  };

  return (
    <div className="relative w-full" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between bg-transparent border-none outline-none text-sm text-white font-mono"
      >
        <span>{selected}</span>
        <ChevronDown className={`w-4 h-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>
      {isOpen && (
        <div className="absolute top-full mt-2 w-full bg-slate-800 border border-slate-700 rounded-md shadow-lg z-10">
          {options.map((option) => (
            <div
              key={option}
              className={`group flex items-center justify-between px-3 py-2 text-sm font-mono cursor-pointer hover:bg-slate-700 ${selected === option ? 'bg-blue-600 text-white' : 'text-white'}`}
              onClick={() => handleSelect(option)}
            >
              <span className="truncate">{option}</span>
              {onRemove && option !== protectedOption && (
                <button
                  type="button"
                  className="ml-2 p-1 rounded text-slate-300 opacity-0 group-hover:opacity-100 hover:bg-slate-600 hover:text-red-300"
                  title="Remove this server"
                  onClick={(e) => { e.stopPropagation(); onRemove(option); }}
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
