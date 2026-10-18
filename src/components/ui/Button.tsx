"use client";

import { ButtonHTMLAttributes, forwardRef } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = "primary",
      size = "md",
      loading = false,
      disabled,
      className = "",
      children,
      ...props
    },
    ref
  ) => {
    const base =
      "inline-flex items-center justify-center font-semibold rounded-lg cursor-pointer select-none transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out active:translate-y-px disabled:opacity-50 disabled:cursor-not-allowed disabled:active:translate-y-0";

    const variants = {
      primary:
        "bg-primary text-on-primary shadow-sm shadow-primary/30 hover:bg-primary-hover hover:shadow-md hover:shadow-primary/30 active:bg-primary-active active:shadow-none",
      secondary:
        "bg-surface border border-line-strong text-fg hover:border-fg-subtle hover:bg-surface-2 active:bg-canvas",
      ghost: "bg-transparent text-fg-muted hover:bg-surface-2 hover:text-fg active:bg-canvas",
      danger: "bg-danger-fill text-on-primary hover:bg-red-700 active:bg-red-800",
    };

    const sizes = {
      sm: "text-sm h-8 px-3 gap-1.5",
      md: "text-sm h-10 px-4 gap-2",
      lg: "text-base h-12 px-6 gap-2",
    };

    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
        {...props}
      >
        {loading && (
          <svg
            className="animate-spin h-4 w-4"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
        )}
        {children}
      </button>
    );
  }
);

Button.displayName = "Button";
