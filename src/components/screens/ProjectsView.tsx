import React, { useState } from 'react';
import { Project } from '../../types';

interface ProjectsViewProps {
  projects: Project[];
  onSelectProject: (project: Project) => void;
  onCreateProject: (name: string) => void;
}

export const ProjectsView: React.FC<ProjectsViewProps> = ({
  projects,
  onSelectProject,
  onCreateProject,
}) => {
  const [showNewModal, setShowNewModal] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (newProjectName.trim()) {
      onCreateProject(newProjectName.trim());
      setNewProjectName('');
      setShowNewModal(false);
    }
  };

  return (
    <main className="flex-grow flex flex-col items-center justify-start pt-[14vh] md:pt-[18vh] px-gutter md:px-margin-safe pb-xxl max-w-7xl mx-auto w-full">
      {/* Header Section */}
      <header className="text-center mb-xl w-full max-w-4xl mx-auto flex flex-col items-center">
        <h1 className="font-display-lg text-display-lg text-primary tracking-tight mb-md select-none font-extralight">
          AURA Virtual Stage
        </h1>
        <p className="font-body-md text-on-surface-variant max-w-md mx-auto mb-lg leading-relaxed text-sm opacity-80">
          AI 3D Scene Generation, Character Motion Choreography & Virtual Camera Production.
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-md sm:gap-xl">
          <button
            onClick={() => setShowNewModal(true)}
            className="font-label-caps text-label-caps text-primary border border-primary px-lg py-sm rounded-none hover:bg-primary hover:text-background transition-colors duration-300 cursor-pointer uppercase tracking-widest font-medium"
          >
            NEW PROJECT
          </button>
          <button
            onClick={() => {
              if (projects.length > 0) onSelectProject(projects[0]);
            }}
            className="font-label-caps text-label-caps text-on-surface-variant hover:text-primary transition-colors duration-300 bg-transparent border border-transparent cursor-pointer tracking-widest uppercase font-medium"
          >
            OPEN RECENT
          </button>
        </div>
      </header>

      {/* Projects Grid */}
      <section className="w-full mt-lg md:mt-xl">
        <div className="flex items-center justify-between mb-md pb-xs border-b border-outline-variant/20">
          <span className="font-label-caps text-[11px] text-on-surface-variant tracking-[0.2em] uppercase">
            RECENT PRODUCTIONS ({projects.length})
          </span>
          <span className="font-label-caps text-[11px] text-outline-variant tracking-wider">
            LOCAL REPOSITORY
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-gutter lg:gap-xl">
          {projects.map((project) => (
            <article
              key={project.id}
              onClick={() => onSelectProject(project)}
              className="project-card group cursor-pointer flex flex-col gap-sm"
            >
              <div className="aspect-video w-full overflow-hidden bg-surface-container border border-surface-container-highest group-hover:border-outline-variant transition-colors duration-300 relative">
                <img
                  src={project.thumbnail}
                  alt={`${project.name} thumbnail`}
                  className="w-full h-full object-cover project-thumb"
                  loading="lazy"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-background/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex items-end p-md">
                  <span className="font-label-caps text-[10px] text-primary tracking-widest flex items-center gap-xs">
                    <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
                    OPEN STAGE
                  </span>
                </div>
              </div>
              <div className="pt-xs">
                <h2 className="font-headline-sm text-headline-sm text-primary group-hover:text-primary transition-colors font-medium">
                  {project.name}
                </h2>
                <p className="font-label-caps text-[10px] text-on-surface-variant mt-xs tracking-wider">
                  Modified {project.modified}
                </p>
              </div>
            </article>
          ))}
        </div>
      </section>

      {/* New Project Modal */}
      {showNewModal && (
        <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-md flex items-center justify-center p-md">
          <div className="bg-surface-container border border-outline-variant/40 p-xl max-w-md w-full shadow-2xl relative">
            <div className="flex justify-between items-center mb-lg">
              <h3 className="font-headline-sm text-headline-sm text-primary">New Production Project</h3>
              <button
                onClick={() => setShowNewModal(false)}
                className="text-on-surface-variant hover:text-primary cursor-pointer"
              >
                <span className="material-symbols-outlined text-[20px]">close</span>
              </button>
            </div>
            <form onSubmit={handleCreateSubmit}>
              <label className="font-label-caps text-label-caps text-on-surface-variant block mb-xs tracking-widest">
                PROJECT NAME
              </label>
              <input
                type="text"
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                placeholder="e.g. Cyberpunk Alleyway"
                autoFocus
                className="w-full bg-surface-container-low border border-outline-variant/40 px-md py-sm text-primary font-body-md focus:outline-none focus:border-primary mb-lg"
              />
              <div className="flex justify-end gap-md">
                <button
                  type="button"
                  onClick={() => setShowNewModal(false)}
                  className="font-label-caps text-label-caps text-on-surface-variant px-md py-sm hover:text-primary cursor-pointer"
                >
                  CANCEL
                </button>
                <button
                  type="submit"
                  className="font-label-caps text-label-caps bg-primary text-background px-lg py-sm hover:bg-white/90 cursor-pointer font-medium"
                >
                  CREATE PROJECT
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </main>
  );
};
