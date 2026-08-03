import React, { useState } from 'react';
import { MarkdownRenderer } from './MarkdownRenderer';

interface TaskDetail {
  id: number;
  title: string;
  state: string;
  workItemType: string;
  assignedTo: string;
  creator?: string;
  description?: string;
  acceptanceCriteria?: string;
  tags?: string;
  areaPath?: string;
  iterationPath?: string;
  reproSteps?: string;
  systemInfo?: string;
  comments?: Array<{
    author?: string;
    createdBy?: { displayName: string } | string;
    text: string;
    date?: string;
    createdDate?: string;
  }>;
}

interface Props {
  detail: TaskDetail;
  onClarify: (workItemId: number, question: string) => void;
  onCheckReplies: (workItemId: number) => void;
  onClose: () => void;
}

function getCommentAuthor(c: { author?: string; createdBy?: { displayName: string } | string }): string {
  if (c.author) return c.author;
  if (c.createdBy) {
    if (typeof c.createdBy === 'object') return c.createdBy.displayName;
    return c.createdBy;
  }
  return 'Unknown';
}

function getCommentDate(c: { date?: string; createdDate?: string }): string | undefined {
  return c.date || c.createdDate;
}

export function TaskDetailPanel({ detail, onClarify, onCheckReplies, onClose }: Props) {
  const [expanded, setExpanded] = useState(true);
  const [question, setQuestion] = useState('');

  const handleClarify = () => {
    if (question.trim()) {
      onClarify(detail.id, question.trim());
      setQuestion('');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleClarify();
    }
  };

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '';
    try {
      return new Date(dateStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch {
      return dateStr;
    }
  };

  return (
    <div className="task-detail">
      <div className="task-detail-header" onClick={() => setExpanded(!expanded)}>
        <span className={`task-detail-chevron ${expanded ? 'open' : ''}`}>▶</span>
        <span className="task-detail-id">ADO-{detail.id}</span>
        <span className="task-detail-title">{detail.title}</span>
        <span className="task-detail-state">{detail.state}</span>
      </div>

      {expanded && (
        <div className="task-detail-body">
          <div className="task-detail-meta">
            <span>{detail.workItemType}</span>
            {detail.assignedTo && <span>→ {detail.assignedTo}</span>}
            {detail.creator && <span>by {detail.creator}</span>}
            {detail.areaPath && <span>📁 {detail.areaPath}</span>}
            {detail.iterationPath && <span>📅 {detail.iterationPath}</span>}
          </div>

          {detail.description && (
            <div className="task-detail-section">
              <div className="task-detail-section-title">Description</div>
              <div className="task-detail-section-content">
                <MarkdownRenderer content={detail.description} />
              </div>
            </div>
          )}

          {detail.acceptanceCriteria && (
            <div className="task-detail-section">
              <div className="task-detail-section-title">Acceptance Criteria</div>
              <div className="task-detail-section-content">
                <MarkdownRenderer content={detail.acceptanceCriteria} />
              </div>
            </div>
          )}

          {detail.reproSteps && (
            <div className="task-detail-section">
              <div className="task-detail-section-title">Repro Steps</div>
              <div className="task-detail-section-content">
                <MarkdownRenderer content={detail.reproSteps} />
              </div>
            </div>
          )}

          {detail.systemInfo && (
            <div className="task-detail-section">
              <div className="task-detail-section-title">System Info</div>
              <div className="task-detail-section-content">
                <MarkdownRenderer content={detail.systemInfo} />
              </div>
            </div>
          )}

          {detail.tags && (
            <div className="task-detail-section">
              <div className="task-detail-section-title">Tags</div>
              <div className="task-detail-section-content" style={{ fontSize: '0.85em' }}>
                {detail.tags}
              </div>
            </div>
          )}

          {detail.comments && detail.comments.length > 0 && (
            <div className="task-detail-comments">
              <div className="task-detail-section-title">
                Discussion ({detail.comments.length})
              </div>
              {detail.comments.map((c, i) => (
                <div key={i} className="task-detail-comment">
                  <div className="task-detail-comment-header">
                    <span className="task-detail-comment-author">
                      {getCommentAuthor(c)}
                    </span>
                    {getCommentDate(c) && (
                      <span className="task-detail-comment-date">
                        {formatDate(getCommentDate(c))}
                      </span>
                    )}
                  </div>
                  <div className="task-detail-comment-text">
                    <MarkdownRenderer content={c.text} />
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="task-detail-actions">
            <input
              className="form-input"
              value={question}
              onChange={e => setQuestion(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask the creator a question…"
            />
            <button className="pill-btn" onClick={handleClarify} title="Post clarification request to ADO thread">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/><path d="M5.255 5.786a.237.237 0 0 0 .241.247h.825c.138 0 .248-.113.266-.25.09-.656.54-1.134 1.342-1.134.686 0 1.314.343 1.314 1.168 0 .635-.374.927-.965 1.371-.673.489-1.206 1.06-1.168 1.987l.003.217a.25.25 0 0 0 .25.246h.811a.25.25 0 0 0 .25-.25v-.105c0-.718.273-.927 1.01-1.486.609-.463 1.244-.977 1.244-2.056 0-1.511-1.276-2.241-2.673-2.241-1.267 0-2.655.59-2.75 2.286zm1.557 5.763c0 .533.425.927 1.01.927.609 0 1.028-.394 1.028-.927 0-.552-.42-.94-1.029-.94-.584 0-1.009.388-1.009.94z"/></svg>
              Clarify
            </button>
            <button className="pill-btn" onClick={() => onCheckReplies(detail.id)} title="Check for new replies">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16zm.93-9.412-1 4.705c-.07.34.029.533.304.533.194 0 .487-.07.686-.246l-.088.416c-.287.346-.92.598-1.465.598-.703 0-1.002-.422-.808-1.319l.738-3.468c.064-.293.006-.399-.287-.399l-.451.004.08-.416c.287-.346.92-.598 1.465-.598.703 0 1.002.422.808 1.319zM8 5.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2z"/></svg>
              Check
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
