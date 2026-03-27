import { forwardRef } from 'react'
import { cn } from '@/lib/utils'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline' | 'pill'
  size?: 'sm' | 'md' | 'lg' | 'icon' | 'icon-sm'
  isLoading?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', isLoading, children, disabled, ...props }, ref) => {
    return (
      <button
        ref={ref}
        disabled={disabled || isLoading}
        className={cn(
          'inline-flex items-center justify-center gap-2 font-medium transition-all duration-150 select-none',
          'focus-visible:outline-none disabled:opacity-40 disabled:cursor-not-allowed',
          // Variants
          variant === 'primary' && 'bg-[--text-primary] text-[--bg] rounded-xl hover:opacity-90 active:scale-[0.97]',
          variant === 'pill'    && 'bg-[--text-primary] text-[--bg] rounded-full hover:opacity-80 active:scale-[0.97]',
          variant === 'secondary' && 'bg-[--bg-subtle] text-[--text-primary] rounded-xl hover:bg-[--bg-inset] active:scale-[0.97]',
          variant === 'ghost' && 'text-[--text-secondary] rounded-xl hover:bg-[--bg-subtle] hover:text-[--text-primary] active:scale-[0.97]',
          variant === 'outline' && 'text-[--text-primary] rounded-xl hover:bg-[--bg-subtle] active:scale-[0.97]',
          variant === 'danger' && 'bg-red-500/8 text-red-500 rounded-xl hover:bg-red-500/12 active:scale-[0.97]',
          // Sizes
          size === 'sm'      && 'h-8 px-3 text-[13px]',
          size === 'md'      && 'h-10 px-4 text-sm',
          size === 'lg'      && 'h-12 px-6 text-[15px]',
          size === 'icon'    && 'h-9 w-9 rounded-xl',
          size === 'icon-sm' && 'h-7 w-7 rounded-lg',
          className,
        )}
        {...props}
      >
        {isLoading
          ? <span className="h-4 w-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
          : children}
      </button>
    )
  },
)
Button.displayName = 'Button'
