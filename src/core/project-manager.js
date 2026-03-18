"use strict";

class ProjectManager {
  constructor(deps) {
    this.cfg = deps.cfg;
    this.ensureInitialized = deps.ensureInitialized;
    this.resolveAgentId = deps.resolveAgentId;
    this.normalizeText = deps.normalizeText;
    this.stablePathKey = deps.stablePathKey;
    this.resolveConfiguredWorkspace = deps.resolveConfiguredWorkspace;
    this.getArchiveDir = deps.getArchiveDir;
    this.randomUUID = deps.randomUUID;
    this.findGitRoot = deps.findGitRoot;
    this.readGitRemote = deps.readGitRemote;
    this.makeManualProjectKey = deps.makeManualProjectKey;
    this.normalizeSelectedProjectKey = deps.normalizeSelectedProjectKey;
    this.path = deps.path;
    this.projectCacheByAgent = new Map();
  }

  resolveWorkspaceRoot(rawAgentId) {
    const agentId = this.resolveAgentId(rawAgentId);
    const explicit = this.normalizeText(this.cfg.projectResolver.workspacePath);
    if (explicit) {
      return this.stablePathKey(this.resolveConfiguredWorkspace(explicit));
    }
    const archiveDir = this.getArchiveDir(agentId);
    if (archiveDir) {
      return this.stablePathKey(this.path.dirname(archiveDir));
    }
    return "";
  }

  getScopedStateKey(stateKey, rawAgentId) {
    return `${stateKey}:${this.resolveAgentId(rawAgentId)}`;
  }

  getStateValue(stateKey, rawAgentId) {
    const scopedKey = this.getScopedStateKey(stateKey, rawAgentId);
    const conn = this.ensureInitialized();
    const row =
      conn
        .prepare(
          `SELECT state_value
             FROM plugin_state
            WHERE state_key = ?
            LIMIT 1`,
        )
        .get(scopedKey) || null;
    return row ? this.normalizeText(row.state_value) : "";
  }

  setStateValue(stateKey, stateValue, rawAgentId) {
    const scopedKey = this.getScopedStateKey(stateKey, rawAgentId);
    const conn = this.ensureInitialized();
    const now = Date.now();
    conn
      .prepare(
        `INSERT INTO plugin_state (state_key, state_value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(state_key) DO UPDATE SET
           state_value = excluded.state_value,
           updated_at = excluded.updated_at`,
      )
      .run(scopedKey, stateValue, now);
  }

  deleteStateValue(stateKey, rawAgentId) {
    const scopedKey = this.getScopedStateKey(stateKey, rawAgentId);
    const conn = this.ensureInitialized();
    conn.prepare(`DELETE FROM plugin_state WHERE state_key = ?`).run(scopedKey);
  }

  getProjectByKey(projectKey) {
    const key = this.normalizeText(projectKey);
    if (!key) {
      return null;
    }
    const conn = this.ensureInitialized();
    const row =
      conn
        .prepare(
          `SELECT project_id, project_key, project_name, source, workspace_path, git_root, git_remote,
                  created_at, updated_at, last_seen_at
             FROM project_registry
            WHERE project_key = ?
            LIMIT 1`,
        )
        .get(key) || null;
    if (!row) {
      return null;
    }
    return {
      projectId: row.project_id,
      projectKey: row.project_key,
      projectName: row.project_name || "",
      source: row.source,
      workspacePath: row.workspace_path || "",
      gitRoot: row.git_root || "",
      gitRemote: row.git_remote || "",
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastSeenAt: row.last_seen_at,
    };
  }

  getManualProjectOverride(rawAgentId) {
    return this.getStateValue("active_project_key", rawAgentId);
  }

  detectProjectContext(rawAgentId) {
    const agentId = this.resolveAgentId(rawAgentId);
    if (!this.cfg.projectResolver.enabled) {
      return null;
    }

    const manualOverride = this.getManualProjectOverride(agentId);
    if (manualOverride) {
      const existingManual = this.getProjectByKey(manualOverride);
      if (existingManual) {
        return {
          projectKey: existingManual.projectKey,
          projectName: existingManual.projectName || existingManual.projectKey.replace(/^manual:/, ""),
          source: "manual",
          workspacePath: existingManual.workspacePath || this.resolveWorkspaceRoot(agentId) || null,
          gitRoot: existingManual.gitRoot || null,
          gitRemote: existingManual.gitRemote || null,
        };
      }
      return {
        projectKey: manualOverride,
        projectName: manualOverride.replace(/^manual:/, ""),
        source: "manual",
        workspacePath: this.resolveWorkspaceRoot(agentId) || null,
        gitRoot: null,
        gitRemote: null,
      };
    }

    const mode = this.cfg.projectResolver.mode;
    const workspaceRoot = this.resolveWorkspaceRoot(agentId);
    const candidates = [];

    if (mode === "manual" || mode === "auto") {
      const manualKey = this.normalizeText(this.cfg.projectResolver.manualKey);
      if (manualKey) {
        candidates.push({
          projectKey: this.makeManualProjectKey(manualKey),
          projectName: this.normalizeText(this.cfg.projectResolver.manualName) || manualKey,
          source: "manual",
          workspacePath: workspaceRoot || null,
          gitRoot: null,
          gitRemote: null,
        });
      }
    }

    if ((mode === "git" || mode === "auto") && workspaceRoot) {
      const gitRoot = this.findGitRoot(workspaceRoot);
      if (gitRoot) {
        const gitRemote = this.readGitRemote(gitRoot);
        candidates.push({
          projectKey: gitRemote ? `git:${gitRemote}` : `git-root:${gitRoot}`,
          projectName: this.path.basename(gitRoot),
          source: "git",
          workspacePath: workspaceRoot,
          gitRoot,
          gitRemote: gitRemote || null,
        });
      }
    }

    if ((mode === "workspace" || mode === "auto") && workspaceRoot) {
      candidates.push({
        projectKey: `workspace:${workspaceRoot}`,
        projectName: this.path.basename(workspaceRoot),
        source: "workspace",
        workspacePath: workspaceRoot,
        gitRoot: null,
        gitRemote: null,
      });
    }

    return candidates[0] || null;
  }

  upsertProjectRegistry(project) {
    const conn = this.ensureInitialized();
    const now = Date.now();
    const existing =
      conn
        .prepare(
          `SELECT project_id, project_key, project_name, source, workspace_path, git_root, git_remote,
                  created_at, updated_at, last_seen_at
             FROM project_registry
            WHERE project_key = ?
            LIMIT 1`,
        )
        .get(project.projectKey) || null;

    if (existing) {
      const nextName = this.normalizeText(project.projectName) || existing.project_name || null;
      conn
        .prepare(
          `UPDATE project_registry
              SET project_name = ?,
                  source = ?,
                  workspace_path = ?,
                  git_root = ?,
                  git_remote = ?,
                  updated_at = ?,
                  last_seen_at = ?
            WHERE project_id = ?`,
        )
        .run(
          nextName,
          project.source,
          project.workspacePath || null,
          project.gitRoot || null,
          project.gitRemote || null,
          now,
          now,
          existing.project_id,
        );
      return {
        projectId: existing.project_id,
        projectKey: existing.project_key,
        projectName: nextName,
        source: project.source,
        workspacePath: project.workspacePath || null,
        gitRoot: project.gitRoot || null,
        gitRemote: project.gitRemote || null,
        createdAt: existing.created_at,
        updatedAt: now,
        lastSeenAt: now,
      };
    }

    const projectId = this.randomUUID();
    conn
      .prepare(
        `INSERT INTO project_registry (
           project_id, project_key, project_name, source, workspace_path, git_root, git_remote,
           created_at, updated_at, last_seen_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        projectId,
        project.projectKey,
        this.normalizeText(project.projectName) || null,
        project.source,
        project.workspacePath || null,
        project.gitRoot || null,
        project.gitRemote || null,
        now,
        now,
        now,
      );

    return {
      projectId,
      projectKey: project.projectKey,
      projectName: this.normalizeText(project.projectName) || null,
      source: project.source,
      workspacePath: project.workspacePath || null,
      gitRoot: project.gitRoot || null,
      gitRemote: project.gitRemote || null,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
    };
  }

  getCurrentProject(forceRefresh, options = {}) {
    const agentId = this.resolveAgentId(options.agentId);
    this.ensureInitialized();
    if (this.projectCacheByAgent.has(agentId) && forceRefresh !== true) {
      return this.projectCacheByAgent.get(agentId) || null;
    }
    const detected = this.detectProjectContext(agentId);
    if (!detected) {
      this.projectCacheByAgent.delete(agentId);
      return null;
    }
    const project = this.upsertProjectRegistry(detected);
    this.projectCacheByAgent.set(agentId, project);
    return project;
  }

  listProjects() {
    const conn = this.ensureInitialized();
    const activeOverride = this.getManualProjectOverride(this.resolveAgentId());
    const rows = conn
      .prepare(
        `SELECT project_id, project_key, project_name, source, workspace_path, git_root, git_remote,
                created_at, updated_at, last_seen_at
           FROM project_registry
          ORDER BY last_seen_at DESC`,
      )
      .all();
    return rows.map((row) => ({
      projectId: row.project_id,
      projectKey: row.project_key,
      projectName: row.project_name || "",
      source: row.source,
      isActiveOverride: activeOverride ? activeOverride === row.project_key : false,
      workspacePath: row.workspace_path || "",
      gitRoot: row.git_root || "",
      gitRemote: row.git_remote || "",
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastSeenAt: row.last_seen_at,
    }));
  }

  bindCurrentProject(projectName, options = {}) {
    const agentId = this.resolveAgentId(options.agentId);
    const current = this.getCurrentProject(true, { agentId });
    if (!current) {
      return null;
    }
    const nextName = this.normalizeText(projectName);
    if (!nextName) {
      return current;
    }
    const conn = this.ensureInitialized();
    const now = Date.now();
    conn
      .prepare(
        `UPDATE project_registry
            SET project_name = ?,
                updated_at = ?,
                last_seen_at = ?
          WHERE project_id = ?`,
      )
      .run(nextName, now, now, current.projectId);
    const nextProject = {
      ...current,
      projectName: nextName,
      updatedAt: now,
      lastSeenAt: now,
    };
    this.projectCacheByAgent.set(agentId, nextProject);
    return nextProject;
  }

  useProject(rawProjectKey, projectName, options = {}) {
    const agentId = this.resolveAgentId(options.agentId);
    const selectedProjectKey = this.normalizeSelectedProjectKey(rawProjectKey);
    if (!selectedProjectKey) {
      return null;
    }
    const existing = this.getProjectByKey(selectedProjectKey);
    if (existing) {
      if (this.normalizeText(projectName)) {
        const renamed = this.upsertProjectRegistry({
          projectKey: existing.projectKey,
          projectName: this.normalizeText(projectName),
          source: existing.source || "manual",
          workspacePath: existing.workspacePath || null,
          gitRoot: existing.gitRoot || null,
          gitRemote: existing.gitRemote || null,
        });
        this.setStateValue("active_project_key", existing.projectKey, agentId);
        this.projectCacheByAgent.set(agentId, renamed);
        return renamed;
      }
      this.setStateValue("active_project_key", existing.projectKey, agentId);
      const updated = this.upsertProjectRegistry({
        projectKey: existing.projectKey,
        projectName: existing.projectName || existing.projectKey.replace(/^manual:/, ""),
        source: existing.source || "manual",
        workspacePath: existing.workspacePath || null,
        gitRoot: existing.gitRoot || null,
        gitRemote: existing.gitRemote || null,
      });
      this.projectCacheByAgent.set(agentId, updated);
      return updated;
    }

    const manualProjectKey = this.makeManualProjectKey(rawProjectKey);
    if (!manualProjectKey) {
      return null;
    }
    const workspaceRoot = this.resolveWorkspaceRoot(agentId);
    const project = this.upsertProjectRegistry({
      projectKey: manualProjectKey,
      projectName: this.normalizeText(projectName) || manualProjectKey.replace(/^manual:/, ""),
      source: "manual",
      workspacePath: workspaceRoot || null,
      gitRoot: null,
      gitRemote: null,
    });
    this.setStateValue("active_project_key", manualProjectKey, agentId);
    this.projectCacheByAgent.set(agentId, project);
    return project;
  }

  clearProjectOverride(options = {}) {
    const agentId = this.resolveAgentId(options.agentId);
    this.deleteStateValue("active_project_key", agentId);
    this.projectCacheByAgent.delete(agentId);
    return this.getCurrentProject(true, { agentId });
  }

  getProjectOverride(options = {}) {
    return this.getManualProjectOverride(this.resolveAgentId(options.agentId));
  }
}

module.exports = {
  ProjectManager,
};
