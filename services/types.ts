export interface RuntimeInfo {
  kind: "node" | "python" | "dockerfile" | "unknown";
  startCommand: string;
  hasDockerfile: boolean;
}

export interface ContainerHandle {
  id: string;
  imageName: string;
  containerName: string;
}

export interface ServiceHandle {
  id: string;
  imageName: string;
  containerName: string;
  hostPort: number;
  containerPort: number;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ToolSchema {
  name: string;
  description: string;
  arguments: Array<{
    name: string;
    description: string;
    required: boolean;
  }>;
}

export interface EnvRequirement {
  key: string;
  description: string;
  required: boolean;
}
