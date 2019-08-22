/**
 * Copyright 2017 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import {EventType} from './events';
import {POLL_INTERVAL_MS} from './page-advancement';
import {Services} from '../../../src/services';
import {StateProperty, getStoreService} from './amp-story-store-service';
import {debounce} from '../../../src/utils/rate-limit';
import {dev, devAssert} from '../../../src/log';
import {escapeCssSelectorNth} from '../../../src/css';
import {hasOwn, map} from '../../../src/utils/object';
import {removeChildren, scopedQuerySelector} from '../../../src/dom';
import {scale, setImportantStyles} from '../../../src/style';

/**
 * Transition used to show the progress of a media. Has to be linear so the
 * animation is smooth and constant.
 * @const {string}
 */
const TRANSITION_LINEAR = `transform ${POLL_INTERVAL_MS}ms linear`;

/**
 * Transition used to fully fill or unfill a progress bar item.
 * @const {string}
 */
const TRANSITION_EASE = 'transform 200ms ease';

/**
 * Size in pixels of a segment ellipse.
 * @const {number}
 */
const ELLIPSE_WIDTH_PX = 2;

/**
 * Size in pixels of the total side margins of a segment.
 * @const {number}
 */
const SEGMENTS_MARGIN_PX = 2;

/**
 * Padding on the sides of the progress bar.
 * @const {number}
 */
const PROGRESS_BAR_PADDING_PX = 4;

/**
 * Maximum number of segments that can be shown at a time before collapsing
 * into ellipsis.
 * @const {number}
 */
const MAX_SEGMENTS = 20;

/**
 * Number of segments we introduce to the bar as we pass an overflow point
 * (when user reaches ellipsis).
 * @const {number}
 */
const SEGMENT_INCREMENT = 5;

/**
 * Progress bar for <amp-story>.
 */
export class ProgressBar {
  /**
   * @param {!Window} win
   * @param {!Element} storyEl
   */
  constructor(win, storyEl) {
    /** @private @const {!Window} */
    this.win_ = win;

    /** @private {boolean} */
    this.isBuilt_ = false;

    /** @private {?Element} */
    this.root_ = null;

    /** @private {number} */
    this.segmentCount_ = 0;

    /** @private {number} */
    this.activeSegmentIndex_ = 0;

    /** @private {number} */
    this.activeSegmentProgress_ = 1;

    /** @private {!../../../src/service/ampdoc-impl.AmpDoc} */
    this.ampdoc_ = Services.ampdocServiceFor(this.win_).getSingleDoc();

    /** @private @const {!../../../src/service/resources-impl.ResourcesDef} */
    this.resources_ = Services.resourcesForDoc(this.ampdoc_);

    /** @private {!Object<string, number>} */
    this.segmentIdMap_ = map();

    /** @private @const {!./amp-story-store-service.AmpStoryStoreService} */
    this.storeService_ = getStoreService(this.win_);

    /** @private {string} */
    this.activeSegmentId_ = '';

    /** @private {!Array<!Element>} */
    this.segments_ = [];

    /**
     * First expanded segment after ellipsis (if any) for stories with segments
     * > MAX_SEGMENTS.
     * @private {number}
     */
    this.firstExpandedSegmentIndex_ = 0;

    /**
     * Width of the progress bar in pixels.
     * @private {number}
     */
    this.barWidthPx_ = 0;

    /** @private {!Element} */
    this.storyEl_ = storyEl;
  }

  /**
   * @param {!Window} win
   * @param {!Element} storyEl
   * @return {!ProgressBar}
   */
  static create(win, storyEl) {
    return new ProgressBar(win, storyEl);
  }

  /**
   * Builds the progress bar.
   *
   * @return {!Element}
   */
  build() {
    if (this.isBuilt_) {
      return this.getRoot();
    }

    this.root_ = this.win_.document.createElement('ol');
    this.root_.classList.add('i-amphtml-story-progress-bar');
    this.storyEl_.addEventListener(EventType.REPLAY, () => {
      this.replay_();
    });

    this.storeService_.subscribe(
      StateProperty.PAGE_IDS,
      pageIds => {
        if (this.isBuilt_) {
          this.clear_();
        }

        pageIds.forEach(id => {
          if (!(id in this.segmentIdMap_)) {
            this.addSegment_(id);
          }
        });

        if (this.isBuilt_) {
          this.updateProgress(
            this.activeSegmentId_,
            this.activeSegmentProgress_,
            true /** updateAllSegments */
          );
        }
      },
      true /** callToInitialize */
    );

    this.storeService_.subscribe(
      StateProperty.RTL_STATE,
      rtlState => {
        this.onRtlStateUpdate_(rtlState);
      },
      true /** callToInitialize */
    );

    Services.viewportForDoc(this.ampdoc_).onResize(
      debounce(this.win_, () => this.onResize_(), 300)
    );

    this.resources_.measureElement(() => {
      this.barWidthPx_ =
        this.storyEl_
          .querySelector('amp-story-page')
          ./*OK*/ getBoundingClientRect().width - PROGRESS_BAR_PADDING_PX;
    });

    this.isBuilt_ = true;
    return this.getRoot();
  }

  /**
   * Reacts to story replay.
   * @private
   */
  replay_() {
    this.firstExpandedSegmentIndex_ = 0;
    this.render_(false /** shouldAnimate */);
  }

  /**
   * Renders the segments by setting their corresponding scaleX and translate.
   * @param {boolean} shouldAnimate
   * @private
   */
  render_(shouldAnimate = true) {
    const segmentWidth = this.getSegmentWidth_();
    let translateX =
      -(this.firstExpandedSegmentIndex_ - this.getPrevEllipsisCount_()) *
      (ELLIPSE_WIDTH_PX + SEGMENTS_MARGIN_PX);

    this.resources_
      .mutateElement(this.root_, () => {
        for (let index = 0; index < this.segmentCount_; index++) {
          const width =
            index >= this.firstExpandedSegmentIndex_ &&
            index < this.firstExpandedSegmentIndex_ + MAX_SEGMENTS
              ? segmentWidth
              : ELLIPSE_WIDTH_PX;
          this.transform_(this.segments_[index], translateX, width);
          translateX += width + SEGMENTS_MARGIN_PX;
        }
      })
      .then(() => {
        this.root_.classList.toggle(
          'i-amphtml-animate-progress',
          shouldAnimate
        );
      });
  }

  /**
   * Applies transform to a segment.
   * @param {!Element} segment
   * @param {number} translateX
   * @param {number} width
   * @private
   */
  transform_(segment, translateX, width) {
    if (this.storeService_.get(StateProperty.RTL_STATE)) {
      translateX *= -1;
    }

    // Do not remove translateZ(0.00001px) as it prevents an iOS repaint issue.
    // http://mir.aculo.us/2011/12/07/the-case-of-the-disappearing-element/
    segment.setAttribute(
      'style',
      `transform: translate3d(${translateX}px, 0px, 0.00001px) scaleX(${width /
        ELLIPSE_WIDTH_PX});`
    );
  }

  /**
   * Gets the individual segment width.
   * @return {number}
   * @private
   */
  getSegmentWidth_() {
    const nextEllipsisCount = this.getNextEllipsisCount_();
    const prevEllipsisCount = this.getPrevEllipsisCount_();
    const totalEllipsisWidth =
      (nextEllipsisCount + prevEllipsisCount) *
      (ELLIPSE_WIDTH_PX + SEGMENTS_MARGIN_PX);
    const totalSegmentsWidth = this.barWidthPx_ - totalEllipsisWidth;

    return (
      totalSegmentsWidth / Math.min(this.segmentCount_, MAX_SEGMENTS) -
      SEGMENTS_MARGIN_PX
    );
  }

  /**
   * Gets the number of ellipsis that should appear to the right (in LTR) of the
   * expanded segments.
   * @return {number}
   * @private
   */
  getNextEllipsisCount_() {
    const nextPagesCount =
      this.segmentCount_ - (this.firstExpandedSegmentIndex_ + MAX_SEGMENTS);
    return nextPagesCount > 3 ? 3 : Math.max(nextPagesCount, 0);
  }

  /**
   * Gets the number of ellipsis that should appear to the left (in LTR) of the
   * expanded segments.
   * @return {number}
   * @private
   */
  getPrevEllipsisCount_() {
    return Math.min(3, this.firstExpandedSegmentIndex_);
  }

  /**
   * Checks if an index is past the MAX_SEGMENTS limit and updates the progress
   * bar accordingly.
   * @private
   */
  checkIndexForOverflow_() {
    // Touching an ellipsis on the right (LTR).
    if (
      this.activeSegmentIndex_ >=
      this.firstExpandedSegmentIndex_ + MAX_SEGMENTS
    ) {
      const nextLimit =
        this.firstExpandedSegmentIndex_ + MAX_SEGMENTS + SEGMENT_INCREMENT - 1;

      this.firstExpandedSegmentIndex_ +=
        nextLimit < this.segmentCount_
          ? SEGMENT_INCREMENT
          : this.segmentCount_ -
            (this.firstExpandedSegmentIndex_ + MAX_SEGMENTS);

      this.render_();
    }
    // Touching an ellipsis on the left (LTR).
    else if (this.activeSegmentIndex_ < this.firstExpandedSegmentIndex_) {
      this.firstExpandedSegmentIndex_ -=
        this.firstExpandedSegmentIndex_ - SEGMENT_INCREMENT < 0
          ? this.firstExpandedSegmentIndex_
          : SEGMENT_INCREMENT;

      this.render_();
    }
  }

  /**
   * Reacts to RTL state updates and triggers the UI for RTL.
   * @param {boolean} rtlState
   * @private
   */
  onRtlStateUpdate_(rtlState) {
    this.resources_.mutateElement(this.getRoot(), () => {
      rtlState
        ? this.getRoot().setAttribute('dir', 'rtl')
        : this.getRoot().removeAttribute('dir');
    });
  }

  /**
   * Handles resize events.
   * @private
   */
  onResize_() {
    this.resources_.measureElement(() => {
      this.barWidthPx_ =
        this.storyEl_
          .querySelector('amp-story-page')
          ./*OK*/ getBoundingClientRect().width - PROGRESS_BAR_PADDING_PX;
      this.render_(false /** shouldAnimate */);
    });
  }

  /**
   * Builds a new segment element and appends it to the progress bar.
   *
   * @private
   */
  buildSegmentEl_() {
    const segmentProgressBar = this.win_.document.createElement('li');
    segmentProgressBar.classList.add('i-amphtml-story-page-progress-bar');
    const segmentProgressValue = this.win_.document.createElement('div');
    segmentProgressValue.classList.add('i-amphtml-story-page-progress-value');
    segmentProgressBar.appendChild(segmentProgressValue);
    this.root_.appendChild(segmentProgressBar);
    this.segments_.push(segmentProgressBar);
  }

  /**
   * Clears the progress bar.
   */
  clear_() {
    removeChildren(devAssert(this.root_));
    this.segmentIdMap_ = map();
    this.segmentCount_ = 0;
  }

  /**
   * Adds a segment to the progress bar.
   *
   * @param {string} id The id of the segment.
   * @private
   */
  addSegment_(id) {
    this.segmentIdMap_[id] = this.segmentCount_++;
    this.buildSegmentEl_();
  }

  /**
   * Gets the root element of the progress bar.
   *
   * @return {!Element}
   */
  getRoot() {
    return dev().assertElement(this.root_);
  }

  /**
   * Validates that segment id exists.
   *
   * @param {string} segmentId The index to assert validity
   * @private
   */
  assertVaildSegmentId_(segmentId) {
    devAssert(
      hasOwn(this.segmentIdMap_, segmentId),
      'Invalid segment-id passed to progress-bar'
    );
  }

  /**
   * Updates a segment with its corresponding progress.
   *
   * @param {string} segmentId the id of the segment whos progress to change.
   * @param {number} progress A number from 0.0 to 1.0, representing the
   *     progress of the current segment.
   * @param {boolean} updateAllSegments Updates all of the segments.
   */
  updateProgress(segmentId, progress, updateAllSegments = false) {
    this.assertVaildSegmentId_(segmentId);
    const segmentIndex = this.segmentIdMap_[segmentId];

    this.updateProgressByIndex_(segmentIndex, progress);

    if (!this.activeSegmentIndex_) {
      this.getInitialFirstExpandedSegmentIndex_(segmentIndex);
      this.render_(false /** shouldAnimate */);
    }

    // If updating progress for a new segment, update all the other progress
    // bar segments.
    if (this.activeSegmentIndex_ !== segmentIndex || updateAllSegments) {
      this.updateSegments_(
        segmentIndex,
        progress,
        this.activeSegmentIndex_,
        this.activeSegmentProgress_
      );
    }

    this.activeSegmentProgress_ = progress;
    this.activeSegmentIndex_ = segmentIndex;
    this.activeSegmentId_ = segmentId;
    this.checkIndexForOverflow_();
  }

  /**
   * Snap the firstExpandedSegmentIndex_ to its most appropiate place, depending
   * where on the story the user is (could be in the middle of the story).
   * @param {number} segmentIndex
   * @private
   */
  getInitialFirstExpandedSegmentIndex_(segmentIndex) {
    if (
      segmentIndex > MAX_SEGMENTS &&
      segmentIndex + MAX_SEGMENTS < this.segmentCount_
    ) {
      this.firstExpandedSegmentIndex_ =
        segmentIndex - (segmentIndex % MAX_SEGMENTS);
    } else if (segmentIndex > MAX_SEGMENTS) {
      this.firstExpandedSegmentIndex_ = this.segmentCount_ - MAX_SEGMENTS;
    }
  }

  /**
   * Updates all the progress bar segments, and decides whether the update has
   * to be animated.
   *
   * @param {number} activeSegmentIndex
   * @param {number} activeSegmentProgress
   * @param {number} prevSegmentIndex
   * @param {number} prevSegmentProgress
   * @private
   */
  updateSegments_(
    activeSegmentIndex,
    activeSegmentProgress,
    prevSegmentIndex,
    prevSegmentProgress
  ) {
    let shouldAnimatePreviousSegment = false;

    // Animating the transition from one full segment to another, which is the
    // most common case.
    if (prevSegmentProgress === 1 && activeSegmentProgress === 1) {
      shouldAnimatePreviousSegment = true;
    }

    // When navigating forward, animate the previous segment only if the
    // following one does not get fully filled.
    if (activeSegmentIndex > prevSegmentIndex && activeSegmentProgress !== 1) {
      shouldAnimatePreviousSegment = true;
    }

    // When navigating backward, animate the previous segment only if the
    // following one gets fully filled.
    if (prevSegmentIndex > activeSegmentIndex && activeSegmentProgress === 1) {
      shouldAnimatePreviousSegment = true;
    }

    for (let i = 0; i < this.segmentCount_; i++) {
      // Active segment already gets updated through update progress events
      // dispatched by its amp-story-page.
      if (i === activeSegmentIndex) {
        continue;
      }

      const progress = i < activeSegmentIndex ? 1 : 0;

      // Only animate the segment corresponding to the previous page, if needed.
      const withTransition = shouldAnimatePreviousSegment
        ? i === prevSegmentIndex
        : false;

      this.updateProgressByIndex_(i, progress, withTransition);
    }
  }

  /**
   * Updates styles to show progress to a corresponding segment.
   *
   * @param {number} segmentIndex The index of the progress bar segment whose progress should be
   *     changed.
   * @param {number} progress A number from 0.0 to 1.0, representing the
   *     progress of the current segment.
   * @param {boolean=} withTransition
   * @public
   */
  updateProgressByIndex_(segmentIndex, progress, withTransition = true) {
    // Offset the index by 1, since nth-child indices start at 1 while
    // JavaScript indices start at 0.
    const nthChildIndex = segmentIndex + 1;
    const progressEl = scopedQuerySelector(
      this.getRoot(),
      `.i-amphtml-story-page-progress-bar:nth-child(${escapeCssSelectorNth(
        nthChildIndex
      )}) .i-amphtml-story-page-progress-value`
    );
    this.resources_.mutateElement(progressEl, () => {
      let transition = 'none';
      if (withTransition) {
        // Using an eased transition only if filling the bar to 0 or 1.
        transition =
          progress === 1 || progress === 0
            ? TRANSITION_EASE
            : TRANSITION_LINEAR;
      }
      setImportantStyles(dev().assertElement(progressEl), {
        'transform': scale(`${progress},1`),
        'transition': transition,
      });
    });
  }
}
