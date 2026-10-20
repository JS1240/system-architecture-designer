import './app.css'
import { useProjects } from './store/projectStore'
import { Welcome } from './ui/Welcome'
import { Workspace } from './ui/Workspace'

export default function App() {
  const hasProject = useProjects((s) => !!(s.activeId && s.projects[s.activeId]))
  return hasProject ? <Workspace /> : <Welcome />
}
