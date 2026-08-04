import React, { useEffect, useCallback, useRef } from "react"

export interface DialogProps {
	open: boolean
	onClose: () => void
	title?: string
	children: React.ReactNode
	actions?: React.ReactNode
}

export const Dialog: React.FC<DialogProps> = ({ open, onClose, title, children, actions }) => {
	const backdropRef = useRef<HTMLDivElement>(null)

	const handleKeyDown = useCallback(
		(e: KeyboardEvent) => {
			if (e.key === "Escape") onClose()
		},
		[onClose]
	)

	useEffect(() => {
		if (open) {
			document.addEventListener("keydown", handleKeyDown)
			return () => document.removeEventListener("keydown", handleKeyDown)
		}
	}, [open, handleKeyDown])

	if (!open) return null

	return (
		<div
			ref={backdropRef}
			style={{
				position: "fixed",
				inset: 0,
				zIndex: 10000,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				background: "rgba(0,0,0,0.5)",
			}}
			onClick={(e) => {
				if (e.target === backdropRef.current) onClose()
			}}
		>
			<div
				style={{
					background: "var(--vscode-editor-background)",
					color: "var(--vscode-foreground)",
					border: "1px solid var(--vscode-panel-border)",
					borderRadius: 8,
					padding: 20,
					minWidth: 320,
					maxWidth: "90vw",
					maxHeight: "80vh",
					overflow: "auto",
					boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
				}}
				onClick={(e) => e.stopPropagation()}
			>
				{title && (
					<div
						style={{
							fontSize: "1.1em",
							fontWeight: 600,
							marginBottom: 12,
							paddingBottom: 8,
							borderBottom: "1px solid var(--vscode-panel-border)",
						}}
					>
						{title}
					</div>
				)}
				<div style={{ marginBottom: actions ? 16 : 0 }}>{children}</div>
				{actions && (
					<div
						style={{
							display: "flex",
							justifyContent: "flex-end",
							gap: 8,
							paddingTop: 8,
							borderTop: "1px solid var(--vscode-panel-border)",
						}}
					>
						{actions}
					</div>
				)}
			</div>
		</div>
	)
}
