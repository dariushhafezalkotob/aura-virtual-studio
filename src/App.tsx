import { useState, useEffect } from 'react';
import { Project, WorkflowStage } from './types';
import { TopBar } from './components/common/TopBar';
import { ProjectsView } from './components/screens/ProjectsView';
import { WorkflowSequenceView } from './components/screens/WorkflowSequenceView';
import { SceneDesignView } from './components/screens/SceneDesignView';
import { ActingSetupView } from './components/screens/ActingSetupView';
import { CameraRecordView } from './components/screens/CameraRecordView';

const INITIAL_PROJECTS: Project[] = [
  {
    id: 'proj_1',
    name: 'Desert Echo',
    thumbnail: 'https://images.unsplash.com/photo-1509316975850-ff9c5deb0cd9?auto=format&fit=crop&w=800&q=80',
    modified: '2 days ago',
    description: 'Arid desert outpost with dynamic sandstorms and ancient artifacts.',
    scenes: [],
  },
  {
    id: 'proj_2',
    name: 'Neon Nocturne',
    thumbnail: 'https://images.unsplash.com/photo-1509198397868-475647b2a1e5?auto=format&fit=crop&w=800&q=80',
    modified: '5 days ago',
    description: 'Cyberpunk rain-slicked city alley with neon signage.',
    scenes: [],
  },
  {
    id: 'proj_3',
    name: 'The Glass Forest',
    thumbnail: 'https://images.unsplash.com/photo-1511497584788-87676104235f?auto=format&fit=crop&w=800&q=80',
    modified: '1 week ago',
    description: 'Crystalline forest with luminescent flora and surreal atmosphere.',
    scenes: [],
  },
];

export function App() {
  const [projects, setProjects] = useState<Project[]>(() => {
    const saved = localStorage.getItem('aura_projects');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        // Cleanse any invalid non-glb scene assets from initial test
        const cleansed = parsed.map((p: Project) => ({
          ...p,
          scenes: (p.scenes || []).filter(
            (s) => s.glbUrl && (s.glbUrl.includes('.glb') || s.glbUrl.includes('.gltf') || s.glbUrl.startsWith('blob:'))
          ),
        }));
        return cleansed;
      } catch {
        return INITIAL_PROJECTS;
      }
    }
    return INITIAL_PROJECTS;
  });

  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [currentStage, setCurrentStage] = useState<WorkflowStage>('projects');

  useEffect(() => {
    localStorage.setItem('aura_projects', JSON.stringify(projects));
  }, [projects]);

  const currentProject = projects.find((p) => p.id === currentProjectId) || null;

  const handleSelectProject = (project: Project) => {
    setCurrentProjectId(project.id);
    setCurrentStage('workflow');
  };

  const handleCreateProject = (name: string) => {
    const newProj: Project = {
      id: `proj_${Date.now()}`,
      name,
      thumbnail: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=800&q=80',
      modified: 'Just now',
      scenes: [],
    };
    setProjects([newProj, ...projects]);
    setCurrentProjectId(newProj.id);
    setCurrentStage('workflow');
  };

  const handleUpdateProject = (updated: Project) => {
    setProjects(projects.map((p) => (p.id === updated.id ? updated : p)));
  };

  const getStageSubtitle = (): string => {
    switch (currentStage) {
      case 'stage1_scene':
        return 'Stage 01: Scene Design';
      case 'stage2_acting':
        return 'Stage 02: Acting Setup';
      case 'stage3_camera':
        return 'Stage 03: Camera Record';
      default:
        return 'Studio';
    }
  };

  return (
    <div className="h-screen w-screen bg-background text-on-background flex flex-col font-body-md relative overflow-hidden selection:bg-surface-container-high selection:text-primary">
      {/* Background Radial Glow */}
      <div className="fixed inset-0 pointer-events-none bg-gradient-radial z-0" />

      {/* Top Header Bar */}
      <TopBar
        currentStage={currentStage}
        currentProject={currentProject}
        onNavigate={setCurrentStage}
        subtitle={getStageSubtitle()}
      />

      {/* Stage Views */}
      <div className="flex-1 flex flex-col z-10 overflow-hidden relative min-h-0 h-full">
        {currentStage === 'projects' && (
          <ProjectsView
            projects={projects}
            onSelectProject={handleSelectProject}
            onCreateProject={handleCreateProject}
          />
        )}

        {currentStage === 'workflow' && currentProject && (
          <WorkflowSequenceView
            currentProject={currentProject}
            onSelectStage={setCurrentStage}
          />
        )}

        {currentStage === 'stage1_scene' && currentProject && (
          <SceneDesignView
            currentProject={currentProject}
            onUpdateProject={handleUpdateProject}
          />
        )}

        {currentStage === 'stage2_acting' && currentProject && (
          <ActingSetupView
            currentProject={currentProject}
            onUpdateProject={handleUpdateProject}
          />
        )}

        {currentStage === 'stage3_camera' && currentProject && (
          <CameraRecordView currentProject={currentProject} />
        )}
      </div>
    </div>
  );
}

export default App;
