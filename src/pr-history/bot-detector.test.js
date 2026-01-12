import { filterBotComments } from './bot-detector.js';

describe('filterBotComments', () => {
  describe('known bot detection', () => {
    it('should filter out dependabot comments', () => {
      const comments = [
        { user: { login: 'dependabot[bot]' }, body: 'Bump lodash from 4.0.0 to 4.1.0' },
        { user: { login: 'humanuser' }, body: 'LGTM!' },
      ];

      const filtered = filterBotComments(comments);

      expect(filtered.length).toBe(1);
      expect(filtered[0].user.login).toBe('humanuser');
    });

    it('should filter out renovate bot comments', () => {
      const comments = [
        { user: { login: 'renovate[bot]' }, body: 'Update dependency' },
        { user: { login: 'developer' }, body: 'Nice work!' },
      ];

      const filtered = filterBotComments(comments);

      expect(filtered.length).toBe(1);
      expect(filtered[0].user.login).toBe('developer');
    });

    it('should filter out github-actions bot comments', () => {
      const comments = [{ user: { login: 'github-actions[bot]' }, body: 'CI passed' }];

      const filtered = filterBotComments(comments);

      expect(filtered.length).toBe(0);
    });

    it('should filter out codecov bot comments', () => {
      const comments = [{ user: { login: 'codecov[bot]' }, body: 'Coverage report...' }];

      const filtered = filterBotComments(comments);

      expect(filtered.length).toBe(0);
    });

    it('should filter out sonarcloud bot comments', () => {
      const comments = [{ user: { login: 'sonarqubecloud[bot]' }, body: 'Quality gate passed' }];

      const filtered = filterBotComments(comments);

      expect(filtered.length).toBe(0);
    });

    it('should filter out vercel bot comments', () => {
      const comments = [{ user: { login: 'vercel[bot]' }, body: 'Preview deployed' }];

      const filtered = filterBotComments(comments);

      expect(filtered.length).toBe(0);
    });
  });

  describe('bot username pattern detection', () => {
    it('should filter usernames ending with [bot]', () => {
      const comments = [
        { user: { login: 'custom-tool[bot]' }, body: 'Automated message' },
        { user: { login: 'realuser' }, body: 'Human feedback' },
      ];

      const filtered = filterBotComments(comments);

      expect(filtered.length).toBe(1);
      expect(filtered[0].user.login).toBe('realuser');
    });

    it('should filter usernames starting with bot-', () => {
      const comments = [{ user: { login: 'bot-reviewer' }, body: 'Review' }];

      const filtered = filterBotComments(comments);

      expect(filtered.length).toBe(0);
    });

    it('should filter usernames ending with -bot', () => {
      const comments = [{ user: { login: 'review-bot' }, body: 'Check' }];

      const filtered = filterBotComments(comments);

      expect(filtered.length).toBe(0);
    });

    it('should filter dependabot variations', () => {
      const comments = [
        { user: { login: 'dependabot-preview' }, body: 'Preview' },
        { user: { login: 'Dependabot' }, body: 'Update' },
      ];

      const filtered = filterBotComments(comments);

      expect(filtered.length).toBe(0);
    });

    it('should filter ci-bot variations', () => {
      const comments = [{ user: { login: 'ci-bot' }, body: 'CI' }];

      const filtered = filterBotComments(comments);

      expect(filtered.length).toBe(0);
    });
  });

  describe('human comment preservation', () => {
    it('should keep comments from regular users', () => {
      const comments = [
        { user: { login: 'john-doe' }, body: 'Great PR!' },
        { user: { login: 'jane_smith' }, body: 'Nice refactor' },
        { user: { login: 'developer123' }, body: 'LGTM' },
      ];

      const filtered = filterBotComments(comments);

      expect(filtered.length).toBe(3);
    });

    it('should keep comments with bot-like words in body but human username', () => {
      const comments = [{ user: { login: 'humandev' }, body: 'This bot detection looks good!' }];

      const filtered = filterBotComments(comments);

      expect(filtered.length).toBe(1);
    });
  });

  describe('alternative user properties', () => {
    it('should handle author_login property', () => {
      const comments = [
        { author_login: 'dependabot[bot]', body: 'Update' },
        { author_login: 'human', body: 'Review' },
      ];

      const filtered = filterBotComments(comments);

      expect(filtered.length).toBe(1);
      expect(filtered[0].author_login).toBe('human');
    });

    it('should handle author property', () => {
      const comments = [
        { author: 'github-actions[bot]', body: 'Action' },
        { author: 'developer', body: 'Comment' },
      ];

      const filtered = filterBotComments(comments);

      expect(filtered.length).toBe(1);
      expect(filtered[0].author).toBe('developer');
    });
  });

  describe('edge cases', () => {
    it('should return empty array for non-array input', () => {
      expect(filterBotComments(null)).toEqual([]);
      expect(filterBotComments(undefined)).toEqual([]);
      expect(filterBotComments('not an array')).toEqual([]);
      expect(filterBotComments({})).toEqual([]);
    });

    it('should handle empty array', () => {
      expect(filterBotComments([])).toEqual([]);
    });

    it('should handle comments with missing user property', () => {
      const comments = [{ body: 'Comment without user' }, { user: { login: 'human' }, body: 'Normal comment' }];

      const filtered = filterBotComments(comments);

      expect(filtered.length).toBe(2); // Both kept since first has no user to check
    });

    it('should handle null comments in array', () => {
      const comments = [null, { user: { login: 'human' }, body: 'Valid comment' }, undefined];

      const filtered = filterBotComments(comments);

      expect(filtered.length).toBe(3); // null/undefined are not bots
    });
  });
});
