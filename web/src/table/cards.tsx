// Cards at the table, drawn once: a card's SVG depends only on its id and the manilha seal, so these
// wrappers skip the diff of the whole drawing when the table re-renders around them (the colors of
// the theme and the four-color deck come from CSS, never from props).

import { Component } from 'preact';
import { Card, CardBack } from '../deck/Card.tsx';
import { MedallionLine } from '../deck/tiles.tsx';

export class CardView extends Component<{ card: number; manilha?: boolean }> {
  override shouldComponentUpdate(next: { card: number; manilha?: boolean }): boolean {
    return next.card !== this.props.card || !!next.manilha !== !!this.props.manilha;
  }

  override render() {
    return <Card card={this.props.card} manilha={this.props.manilha} />;
  }
}

export class BackView extends Component {
  override shouldComponentUpdate(): boolean {
    return false;
  }

  override render() {
    return <CardBack />;
  }
}

export class MedallionView extends Component<{ class: string }> {
  override shouldComponentUpdate(next: { class: string }): boolean {
    return next.class !== this.props.class;
  }

  override render() {
    return <MedallionLine class={this.props.class} />;
  }
}
