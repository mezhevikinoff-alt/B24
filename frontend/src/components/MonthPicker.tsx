import React from 'react';
import { format, addMonths, subMonths } from 'date-fns';
import { ru } from 'date-fns/locale';

interface Props {
  value: Date;
  onChange: (d: Date) => void;
}

export function MonthPicker({ value, onChange }: Props) {
  const label = format(value, 'LLLL yyyy', { locale: ru });

  return (
    <div className="flex items-center gap-3 bg-white rounded-xl px-4 py-2 shadow-sm border border-gray-200">
      <button
        onClick={() => onChange(subMonths(value, 1))}
        className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-600 font-bold text-lg"
      >
        ‹
      </button>
      <span className="text-base font-semibold text-gray-800 capitalize min-w-[160px] text-center">
        {label}
      </span>
      <button
        onClick={() => onChange(addMonths(value, 1))}
        className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-600 font-bold text-lg"
        disabled={value >= new Date()}
      >
        ›
      </button>
    </div>
  );
}
