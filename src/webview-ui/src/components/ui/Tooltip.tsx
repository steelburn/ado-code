import React, { useState, useCallback } from "react"
import { cn } from "./cn"

export type TooltipSide = "top" | "bottom" | "left" | "right"

export interface TooltipProps {
	content: React.ReactNode
	children: React.ReactElement
	side?: TooltipSide
	className?: string
}

const sideStyles: Record<TooltipSide, React.CSSProperties> = {
	top: { bottom: "100%", left: "50%", transform: "translateX(-50%)", marginBottom: 6 },
	bottom: { top: "100%", left: "50%", transform: "translateX(-50%)", marginTop: 6 },
	left: { right: "100%", top: "50%", transform: "translateY(-50%)", marginRight: 6 },
	right: { left: "100%", top: "50%", transform: "translateY(-50%)", marginLeft: 6 },
}

export const Tooltip: React.FC<TooltipProps> = ({ content, children, side = "top", className }) => {
	const [visible, setVisible] = useState(false)

	const show = useCallback(() => setVisible(true), [])
	const hide = useCallback(() => setVisible(false), [])

	return (
		<span
			style={{ position: "relative", display: "inline-flex" }}
			onMouseEnter={show}
			onMouseLeave={hide}
			onFocus={show}
			onBlur={hide}
		>
			{children}
			{visible && (
				<span
					className={cn(className)}
					style={{
						position: "absolute",
						zIndex: 9999,
						...sideStyles[side],
						background: "var(--vscode-editorHoverWidget-background)",
						color: "var(--vscode-editorHoverWidget-foreground)",
						border: "1px solid var(--vscode-editorHoverWidget-border)",
						borderRadius: 4,
						padding: "4px 8px",
						fontSize: "0.8em",
						lineHeight: 1.4,
						whiteSpace: "nowrap",
						maxWidth: 300,
						pointerEvents: "none",
						boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
					}}
					role="tooltip"
				>
					{content}
				</span>
			)}
		</span>
	)
}
