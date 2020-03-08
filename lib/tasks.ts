import {
  bold,
  green,
  yellow
} from "https://deno.land/std@v0.35.0/fmt/colors.ts";
import { existsSync } from "https://deno.land/std@v0.35.0/fs/mod.ts";
import { Graph } from "./graph.ts";
import {
  abort,
  DrakeError,
  env,
  isFileTask,
  isNormalTask,
  log,
  normalizePrereqs,
  normalizeTaskName
} from "./utils.ts";

export type Action = (this: Task) => any;

/** Drake task. */
export class Task {
  /** Unique task name or file path */
  name: string;
  desc: string;
  prereqs: string[];
  action?: Action;

  /**
   * Create a new task.
   * Task name and prerequisite names are normalized.
   */
  constructor(name: string, desc: string, prereqs: string[], action?: Action) {
    name = normalizeTaskName(name);
    this.name = name;
    this.desc = desc;
    this.prereqs = normalizePrereqs(prereqs);
    if (action) {
      this.action = action.bind(this);
    }
  }

  /**
   * Return true if either the task name file does not exist or one or more prerequisite files has a
   * more recent modification time. Otherwise return false.
   *
   * - Return true if the task is not a file task.
   * - Throw error if any prerequisite path does not exist.
   */
  isOutOfDate(): boolean {
    if (!isFileTask(this.name)) {
      return true;
    }
    // Check all prerequisite paths exist.
    for (const name of this.prereqs) {
      if (!isFileTask(name)) {
        continue;
      }
      if (!existsSync(name)) {
        abort(
          `task: ${this.name}: missing prerequisite path: ${name}`
        );
      }
    }
    if (!existsSync(this.name)) {
      return true;
    }
    const targetStat = Deno.statSync(this.name);
    for (const prereq of this.prereqs) {
      if (!isFileTask(prereq)) {
        continue;
      }
      const prereqStat = Deno.statSync(prereq);
      if (!targetStat.modified || !prereqStat.modified) {
        continue;
      }
      if (targetStat.modified <= prereqStat.modified) {
        return true;
      }
    }
    return false;
  }
}

/** Task registry map. */
export class TaskRegistry extends Map<string, Task> {
  lastDesc: string;

  constructor() {
    super();
    this.lastDesc = "";
  }

  /**
   * Lookup task by task name.
   * Throw error if task does not exist.
   */
  get(name: string): Task {
    name = normalizeTaskName(name);
    if (!this.has(name)) {
      abort(`missing task: ${name}`);
    }
    return super.get(name)!;
  }

  /**
   * Add task to registry.
   * Throw error if task is already registered.
   */
  set(name: string, task: Task) {
    name = normalizeTaskName(name);
    if (this.has(name)) {
      abort(`task already exists: ${name}`);
    }
    return super.set(name, task);
  }

  /** Set description of next registered task. */
  desc(description: string): void {
    this.lastDesc = description;
  }

  /** Create and register a task. */
  register(name: string, prereqs: string[], action?: Action): void {
    this.set(name, new Task(name, this.lastDesc, prereqs, action));
    this.lastDesc = ""; // Consume decription.
  }

  /** Print list of tasks to the console. */
  list(): void {
    const keys = Array.from(this.keys());
    const maxLen = keys.reduce(function(a, b) {
      return a.length > b.length ? a : b;
    }).length;
    for (const k of keys.sort()) {
      const task = this.get(k);
      console.log(
        `${green(bold(task.name.padEnd(maxLen)))} ${task.desc} ${yellow(
          `[${task.prereqs}]`
        )}`
      );
    }
  }

  /**
   * Recursively expand prerequisites and return a list of prerequisite tasks.
   * Throw error if non-file task is missing.
   */
  private expand(names: string[]): Task[] {
    let result: Task[] = [];
    names = names.slice();
    names.reverse(); // Result maintains the same order as the list of names.
    for (const name of names) {
      if (isFileTask(name) && !this.has(name)) {
        continue; // Ignore prerequisite paths that don't have a task.
      }
      const task = this.get(name);
      result.unshift(task);
      result = this.resolveDependencies(task.prereqs).concat(result);
    }
    return result;
  }

  /**
   * Return a list of tasks and all dependent tasks from the list of task names.
   * Ordered in first to last execution order,
   */
  resolveDependencies(names: string[]): Task[] {
    names = names.map(name => normalizeTaskName(name));
    const result: Task[] = [];
    for (const task of this.expand(names)) {
      // Drop downstream dups.
      if (result.find(t => t.name === task.name)) {
        continue;
      }
      result.push(task);
    }
    return result;
  }

  /** Throw error if there are one or more task dependency cycles. */
  checkForCycles(): void {
    const graph = new Graph();
    for (const task of this.keys()) {
      graph.addNode(task, this.get(task).prereqs.filter(p => this.has(p)));
    }
    graph.searchForCycles();
    if (graph.errors.length > 0) {
      abort(graph.errors.join(", "));
    }
  }

  /** Run tasks and prerequisite tasks in the correct dependency order. */
  async run(...names: string[]) {
    this.checkForCycles();
    const tasks = this.resolveDependencies(names);
    log(`${green(bold("task queue:"))} ${tasks.map(t => t.name)}`);
    for (const task of tasks) {
      if (!task.action) {
        continue;
      }
      if (isNormalTask(task.name)) {
        await this.execute(task.name);
      } else {
        await this.executeFileTask(task);
      }
    }
  }

  /**
   * Unconditionally execute task action functions ignoring task prerequisites.
   *
   * - If `names` is a task name string execute the task action.
   * - If `names` is an array of task names execute their actions asynchronously.
   * - Silently skip tasks that have no action function.
   */
  async execute(names: string | string[]) {
    if (typeof names === "string") {
      names = [names];
    }
    names = names.map(name => normalizeTaskName(name));
    if (env["--dry-run"]) {
      log(yellow(`${names} skipped`) + " (dry run)");
      return;
    }
    log(green(bold(`${names} started`)));
    const startTime = new Date().getTime();
    const promises: Promise<any>[] = [];
    for (const name of names) {
      const task = this.get(name);
      if (!task.action) {
        continue;
      }
      if (task.action.constructor.name === "AsyncFunction") {
        promises.push(task.action());
      } else {
        task.action();
      }
    }
    await Promise.all(promises);
    const endTime = new Date().getTime();
    log(
      green(bold(`${names} finished`)) +
        ` in ${((endTime - startTime) / 1000).toFixed(2)} seconds`
    );
  }

  /**
   * Execute file task if it is out of date. If an error occurs the following precautions are taken
   * to ensure the task remains out of date:
   *
   * - If a new target file has been created then it is deleted.
   * - If an existing target file modification date has changed then it is reverted to the prior
   *   date.
   */
  async executeFileTask(task: Task) {
    if (!env["--always-make"] && !task.isOutOfDate()) {
      log(yellow(`${task.name} skipped`) + " (up to date)");
      return;
    }
    const oldInfo = existsSync(task.name) ? Deno.statSync(task.name) : null;
    const savedAbortExits = env["--abort-exits"];
    env["--abort-exits"] = false;
    try {
      await this.execute(task.name);
    } catch (e) {
      env["--abort-exits"] = savedAbortExits;
      const newInfo = existsSync(task.name) ? Deno.statSync(task.name) : null;
      if (!oldInfo && newInfo) {
        Deno.removeSync(task.name); // Delete newly created target file.
      } else if (newInfo && oldInfo &&
        newInfo.modified! > oldInfo.modified!)
      {
        // Reset target timestamps to ensure task executes when next run.
        Deno.utimeSync(task.name, oldInfo.accessed!, oldInfo.modified!);
      }
      if (e instanceof DrakeError) {
        abort(e.message);
      } else {
        throw e;
      }
    } finally {
      env["--abort-exits"] = savedAbortExits;
    }
  }
}
