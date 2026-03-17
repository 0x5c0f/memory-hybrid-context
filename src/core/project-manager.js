"use strict";

class ProjectManager {
  constructor(deps) {
    this.cfg = deps.cfg;
    this.ensureInitialized = deps.ensureInitialized;
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
    this.projectCache = null;
  }

  resolveWorkspaceRoot() {
    const explicit = this.normalizeText(this.cfg.projectResolver.workspacePath);
    if (explicit) {
      return this.stablePathKey(this.resolveConfiguredWorkspace(explicit));
    }
    const archiveDir = this.getArchiveDir();
    if (archiveDir) {
      return this.stablePathKey(this.path.dirname(archiveDir));
    }
    return "";
  }

  getStateValue(stateKey) {
    const conn = this.ensureInitialized();
    const row =
      conn
        .prepare(
          `SELECT state_value
             FROM plugin_state
            WHERE state_key = ?
            LIMIT 1`,
        )
        .get(stateKey) || null;
    return row ? this.normalizeText(row.state_value) : "";
  }

  setStateValue(stateKey, stateValue) {
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
      .run(stateKey, stateValue, now);
  }

  deleteStateValue(stateKey) {
    const conn = this.ensureInitialized();
    conn.prepare(`DELETE FROM plugin_state WHERE state_key = ?`).run(stateKey);
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

  getManualProjectOverride() {
    return this.getStateValue("active_project_key");
  }

  detectProjectContext() {
    if (!this.cfg.projectResolver.enabled) {
      return null;
    }

    const manualOverride = this.getManualProjectOverride();
    if (manualOverride) {
      const existingManual = this.getProjectByKey(manualOverride);
      if (existingManual) {
        return {
          projectKey: existingManual.projectKey,
          projectName: existingManual.projectName || existingManual.projectKey.replace(/^manual:/, ""),
          source: "manual",
          workspacePath: existingManual.workspacePath || this.resolveWorkspaceRoot() || null,
          gitRoot: existingManual.gitRoot || null,
          gitRemote: existingManual.gitRemote || null,
        };
      }
      return {
        projectKey: manualOverride,
        projectName: manualOverride.replace(/^manual:/, ""),
        source: "manual",
        workspacePath: this.resolveWorkspaceRoot() || null,
        gitRoot: null,
        gitRemote: null,
      };
    }

    const mode = this.cfg.projectResolver.mode;
    const workspaceRoot = this.resolveWorkspaceRoot();
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

  getCurrentProject(forceRefresh) {
    this.ensureInitialized();
    if (this.projectCache && forceRefresh !== true) {
      return this.projectCache;
    }
    const detected = this.detectProjectContext();
    if (!detected) {
      this.projectCache = null;
      return null;
    }
    this.projectCache = this.upsertProjectRegistry(detected);
    return this.projectCache;
  }

  listProjects() {
    const conn = this.ensureInitialized();
    const activeOverride = this.getManualProjectOverride();
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

  bindCurrentProject(projectName) {
    const current = this.getCurrentProject(true);
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
    this.projectCache = {
      ...current,
      projectName: nextName,
      updatedAt: now,
      lastSeenAt: now,
    };
    return this.projectCache;
  }

  useProject(rawProjectKey, projectName) {
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
        this.setStateValue("active_project_key", existing.projectKey);
        this.projectCache = renamed;
        return renamed;
      }
      this.setStateValue("active_project_key", existing.projectKey);
      this.projectCache = this.upsertProjectRegistry({
        projectKey: existing.projectKey,
        projectName: existing.projectName || existing.projectKey.replace(/^manual:/, ""),
        source: existing.source || "manual",
        workspacePath: existing.workspacePath || null,
        gitRoot: existing.gitRoot || null,
        gitRemote: existing.gitRemote || null,
      });
      return this.projectCache;
    }

    const manualProjectKey = this.makeManualProjectKey(rawProjectKey);
    if (!manualProjectKey) {
      return null;
    }
    const workspaceRoot = this.resolveWorkspaceRoot();
    const project = this.upsertProjectRegistry({
      projectKey: manualProjectKey,
      projectName: this.normalizeText(projectName) || manualProjectKey.replace(/^manual:/, ""),
      source: "manual",
      workspacePath: workspaceRoot || null,
      gitRoot: null,
      gitRemote: null,
    });
    this.setStateValue("active_project_key", manualProjectKey);
    this.projectCache = project;
    return project;
  }

  clearProjectOverride() {
    this.deleteStateValue("active_project_key");
    this.projectCache = null;
    return this.getCurrentProject(true);
  }

  getProjectOverride() {
    return this.getManualProjectOverride();
  }
}

module.exports = {
  ProjectManager,
};
