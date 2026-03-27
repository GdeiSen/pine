import { forwardRef } from 'react'
import { cn } from '@/lib/utils'

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
  icon?: React.ReactNode
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, error, icon, ...props }, ref) => {
    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label className="text-sm font-medium text-[--text-secondary]">{label}</label>
        )}
        <div className="relative">
          {icon && (
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[--text-muted]">
              {icon}
            </span>
          )}
          <input
            ref={ref}
            className={cn(
              'w-full h-10 rounded-xl border border-[--border] bg-[--bg-elevated]',
              'px-3 text-sm text-[--text-primary] placeholder:text-[--text-muted]',
              'focus:outline-none focus:ring-2 focus:ring-[--color-accent] focus:border-transparent',
              'transition-all duration-150',
              icon && 'pl-10',
              error && 'border-red-400 focus:ring-red-400',
              className,
            )}
            {...props}
          />
        </div>
        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>
    )
  },
)
Input.displayName = 'Input'
