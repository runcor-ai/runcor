import { describe, it, expect } from 'vitest';
import { initCommand } from '../../../src/cli/commands/init.js';
import { devCommand } from '../../../src/cli/commands/dev.js';
import { triggerCommand } from '../../../src/cli/commands/trigger.js';
import { statusCommand } from '../../../src/cli/commands/status.js';
import { resumeCommand } from '../../../src/cli/commands/resume.js';

describe('CLI command definitions', () => {
  const allCommands = [
    { cmd: initCommand, name: 'init' },
    { cmd: devCommand, name: 'dev' },
    { cmd: triggerCommand, name: 'trigger' },
    { cmd: statusCommand, name: 'status' },
    { cmd: resumeCommand, name: 'resume' },
  ];

  for (const { cmd, name } of allCommands) {
    describe(`${name} command`, () => {
      it('has correct name', () => {
        expect(cmd.name).toBe(name);
      });

      it('has a description', () => {
        expect(cmd.description).toBeTruthy();
        expect(typeof cmd.description).toBe('string');
      });

      it('has a usage string', () => {
        expect(cmd.usage).toBeTruthy();
        expect(cmd.usage).toContain('runcor');
        expect(cmd.usage).toContain(name);
      });

      it('has a handler function', () => {
        expect(typeof cmd.handler).toBe('function');
      });

      it('has options as an object', () => {
        expect(typeof cmd.options).toBe('object');
      });
    });
  }

  describe('trigger command positionals', () => {
    it('requires flow name positional', () => {
      expect(triggerCommand.positionals).toBeDefined();
      expect(triggerCommand.positionals!.length).toBeGreaterThan(0);
      expect(triggerCommand.positionals![0].name).toBe('flow');
      expect(triggerCommand.positionals![0].required).toBe(true);
    });
  });

  describe('resume command positionals', () => {
    it('requires id positional', () => {
      expect(resumeCommand.positionals).toBeDefined();
      expect(resumeCommand.positionals!.length).toBeGreaterThan(0);
      expect(resumeCommand.positionals![0].name).toBe('id');
      expect(resumeCommand.positionals![0].required).toBe(true);
    });
  });

  describe('status command options', () => {
    it('has state, flow, limit, and json options', () => {
      expect(statusCommand.options).toHaveProperty('state');
      expect(statusCommand.options).toHaveProperty('flow');
      expect(statusCommand.options).toHaveProperty('limit');
      expect(statusCommand.options).toHaveProperty('json');
    });

    it('limit defaults to 20', () => {
      expect(statusCommand.options['limit'].default).toBe('20');
    });
  });

  describe('trigger command options', () => {
    it('has input, user, no-wait, and json options', () => {
      expect(triggerCommand.options).toHaveProperty('input');
      expect(triggerCommand.options).toHaveProperty('user');
      expect(triggerCommand.options).toHaveProperty('no-wait');
      expect(triggerCommand.options).toHaveProperty('json');
    });
  });
});
