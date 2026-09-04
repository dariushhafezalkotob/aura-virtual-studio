import React, { useState } from 'react';
import { Project } from '../../types';

interface ProjectsViewProps {
  projects: Project[];
  onSelectProject: (project: Project) => void;
  onCreateProject: (name: string) => void;
  onDeleteProject: (projectId: string) => void;
}

export const ProjectsView: React.FC<ProjectsViewProps> = ({
  projects,
  onSelectProject,
  onCreateProject,
  onDeleteProject,
}) => {
  const [showNewModal, setShowNewModal] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null);

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (newProjectName.trim()) {
      onCreateProject(newProjectName.trim());
      setNewProjectName('');
      setShowNewModal(false);
    }
  };

  return (
    <div className="flex-1 w-full h-full overflow-y-auto overflow-x-hidden">
      <main className="flex flex-col items-center justify-start pt-10 md:pt-16 px-gutter md:px-margin-safe pb-28 max-w-7xl mx-auto w-full">
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
              className="font-label-caps text-label-caps text-primary border border-primary px-lg py-sm rounded-none hover:bg-primary hover:text-background transition-colors duration-300 cursor-pointer uppercase tracking-widest font-medium shadow-sm"
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
        <section className="w-full mt-md md:mt-lg">
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
                className="project-card group cursor-pointer flex flex-col gap-sm relative"
              >
                <div className="aspect-video w-full overflow-hidden bg-surface-container border border-surface-container-highest group-hover:border-outline-variant transition-colors duration-300 relative rounded-sm">
                  <img
                    src={project.thumbnail}
                    alt={`${project.name} thumbnail`}
                    className="w-full h-full object-cover project-thumb"
                    loading="lazy"
                  />

                  {/* Delete Button (Top Right Corner) */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setProjectToDelete(project);
                    }}
                    className="absolute top-2 right-2 p-1.5 rounded-lg bg-surface-container-lowest/80 hover:bg-error/90 text-on-surface-variant hover:text-white backdrop-blur-md opacity-80 group-hover:opacity-100 transition-all duration-200 z-20 cursor-pointer border border-outline-variant/30 hover:border-error shadow-sm"
                    title="Delete Project"
                  >
                    <span className="material-symbols-outlined text-[16px] block">delete</span>
                  </button>

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

          {projects.length === 0 && (
            <div className="text-center py-16 border border-dashed border-outline-variant/30 rounded-lg">
              <span className="material-symbols-outlined text-[36px] text-on-surface-variant/50 mb-xs">
                folder_open
              </span>
              <p className="font-body-md text-on-surface-variant text-sm">No production projects yet.</p>
              <button
                onClick={() => setShowNewModal(true)}
                className="mt-md font-label-caps text-xs text-primary underline cursor-pointer"
              >
                Create your first project
              </button>
            </div>
          )}
        </section>

        {/* New Project Modal */}
        {showNewModal && (
          <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-md flex items-center justify-center p-md">
            <div className="bg-surface-container border border-outline-variant/40 p-xl max-w-md w-full shadow-2xl relative rounded-xl">
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
                  className="w-full bg-surface-container-low border border-outline-variant/40 px-md py-sm text-primary font-body-md focus:outline-none focus:border-primary mb-lg rounded"
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
                    className="font-label-caps text-label-caps bg-primary text-background px-lg py-sm hover:bg-white/90 cursor-pointer font-medium rounded"
                  >
                    CREATE PROJECT
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Delete Confirmation Modal */}
        {projectToDelete && (
          <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-md flex items-center justify-center p-md animate-fade-in">
            <div className="bg-surface-container border border-outline-variant/50 p-xl max-w-md w-full shadow-2xl relative rounded-2xl flex flex-col gap-md">
              <div className="flex items-center gap-sm text-error">
                <span className="material-symbols-outlined text-[24px]">delete_forever</span>
                <h3 className="font-headline-sm text-headline-sm text-primary font-bold">
                  Delete Project?
                </h3>
              </div>
              <p className="text-xs text-on-surface-variant leading-relaxed">
                Are you sure you want to delete <span className="text-primary font-semibold">"{projectToDelete.name}"</span>? This action cannot be undone.
              </p>
              <div className="flex justify-end gap-md pt-sm border-t border-outline-variant/20">
                <button
                  type="button"
                  onClick={() => setProjectToDelete(null)}
                  className="font-label-caps text-xs text-on-surface-variant px-lg py-xs hover:text-primary border border-outline-variant/40 rounded hover:bg-surface-variant cursor-pointer font-semibold tracking-wider"
                >
                  NO
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onDeleteProject(projectToDelete.id);
                    setProjectToDelete(null);
                  }}
                  className="font-label-caps text-xs bg-error hover:bg-error/90 text-white px-xl py-xs rounded cursor-pointer font-bold tracking-wider shadow"
                >
                  YES
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};
